"""macOS/Linux 本地持久 shell：openpty + 非阻塞读取。"""

from __future__ import annotations

import asyncio
import fcntl
import os
import pty
import signal
import struct
import termios

from .shell_session import BasePtySession, CommandResult


def _stall_dbg(n: int, first: bool = False) -> None:
    """临时排障：写入 EAGAIN 停滞计数（OT_WEB_DEBUG=1 时可见）。"""
    import os as _os
    if _os.environ.get("OT_WEB_DEBUG"):
        import sys
        print(f"[otdbg] write stalled x{n}{'' if first else ' (recovered)'}",
              flush=True)


class LocalPtySession(BasePtySession):
    def __init__(self, shell: str | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._shell = shell or os.environ.get("SHELL", "/bin/bash")
        self._pid: int | None = None
        self._fd: int | None = None
        # 写入停顿期的输出接收器（asyncio 单线程，同步回调）：setup 注入期
        # 由 worker 设为喂 StreamRouter，打破回显塞满输出队列的死锁
        self._write_sink = None

    async def start(self) -> None:
        pid, fd = pty.fork()
        if pid == 0:  # 子进程
            try:
                env = os.environ.copy()
                env["TERM"] = "xterm-256color"
                os.execve(self._shell, [self._shell, "-l"], env)
            except Exception:
                os._exit(127)
        self._pid, self._fd = pid, fd
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        await self.resize(40, 120)
        # 等初始提示符输出排空
        await self._quiet()

    async def _quiet(self) -> None:
        # 偏离计划（最小）：必须先等到 shell 的首批输出，再做静默排空。
        # 本机登录 zsh 加载 rc 时约 2.4s 内无任何输出；原实现首次 0.5s
        # 超时即返回，会让命令在行编辑器就绪前写入，zsh 随后重绘该行，
        # 重绘文本里的字面哨兵会把 slice_capture 的锚点永久锁死。
        try:
            if not await self._read_some(5.0):
                return
            while True:
                await self._read_some(0.5)
        except (asyncio.TimeoutError, OSError):
            pass

    async def _write_raw(self, data: bytes) -> None:
        assert self._fd is not None
        # 直写，不排空：交互按键（send_raw）走这里，排空会与主循环读者
        # 抢 fd 数据、吞掉提示符/OSC 标记字节，还引入固定 200ms 延迟。
        # fd 是 O_NONBLOCK（读泵需要）：tty 输入队列满（TTYHOG）时 write
        # 抛 BlockingIOError，须等待消费者（shell 行编辑器）排空后重试。
        # 死锁防护：若写方回显已塞满输出队列（泵未启动的 setup 注入期），
        # 行规程因 echo 无处写而拒绝接受输入 → 双向永久 EAGAIN。此时
        # _write_sink（setup 注入期设为喂 router）边写边读输出，打破死锁；
        # 无 sink 时丢弃——该输出本就无读者，不丢则死锁。
        stalls = 0
        while data:
            try:
                n = os.write(self._fd, data)
                data = data[n:]
                if stalls:
                    _stall_dbg(stalls)
                    stalls = 0
            except BlockingIOError:
                stalls += 1
                if stalls == 100:
                    _stall_dbg(stalls, first=True)
                got = b""
                if self._write_sink is not None:
                    try:
                        got = os.read(self._fd, 65_536)
                    except (BlockingIOError, OSError):
                        got = b""
                    if got:
                        self._write_sink(got)
                await asyncio.sleep(0.02)

    async def drain_to_silence(self, quiet: float = 0.2) -> None:
        # 哨兵批写入前：排空到静默。上一条命令的哨兵返回时，zsh 往往还没
        # 画完新提示符，此刻 tty 处于 cooked 模式：写入会被行规范整行回显，
        # 再被 zle 重绘，产生多份带真实换行的字面哨兵，使 slice_capture
        # 锚点永久错位。等提示符画完（zle 就绪）再写。仅批路径调用。
        while True:
            try:
                chunk = await self._read_some(quiet)
            except (asyncio.TimeoutError, OSError):
                break
            if not chunk:
                break

    async def _read_some(self, idle_timeout: float) -> bytes:
        assert self._fd is not None
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[bytes] = loop.create_future()

        def _readable() -> None:
            if fut.done():
                return
            try:
                data = os.read(self._fd, 65_536)
            except BlockingIOError:
                return
            except OSError:
                fut.set_result(b"")
                return
            fut.set_result(data)

        loop.add_reader(self._fd, _readable)
        try:
            return await asyncio.wait_for(fut, timeout=idle_timeout)
        finally:
            loop.remove_reader(self._fd)

    async def _interrupt(self) -> None:
        if self._fd is not None:
            os.write(self._fd, b"\x03")  # Ctrl-C

    async def _recover_connection(self) -> bool:
        """本地：关掉死掉的进程组并重启 shell，语义等同"重新连上"。"""
        await self.close()
        try:
            await self.start()
            await self._notify_reconnect()
            return True
        except OSError:
            return False

    async def _handle_timeout(self) -> CommandResult:
        # 偏离计划（最小）：Ctrl-C 后 zsh 会直接丢弃当前命令行、不打印哨兵，
        # 基类于是重启 shell 并返回 reconnected（exit 1）。本地重启后会话
        # 状态确已丢失，按超时语义返回 124（Task 4 测试约定 124/130）。
        result = await super()._handle_timeout()
        if result.reconnected:
            return CommandResult(
                output=f"Error: 命令超时（{self._default_timeout}s），shell 已重置，会话状态丢失。",
                exit_code=124, truncated=False, cwd=self.cwd,
            )
        return result

    async def resize(self, rows: int, cols: int) -> None:
        if self._fd is None:
            return
        size = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(self._fd, termios.TIOCSWINSZ, size)

    async def send_raw(self, data: bytes) -> None:
        await self._write_raw(data)

    async def close(self) -> None:
        if self._pid is not None:
            try:
                os.killpg(os.getpgid(self._pid), signal.SIGKILL)
            except (ProcessLookupError, OSError):
                try:
                    os.kill(self._pid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    pass
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
        self._pid = self._fd = None
