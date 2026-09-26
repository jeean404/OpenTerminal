"""Windows 本地持久 shell：ConPTY（pywinpty）+ 专职读者线程。

与 LocalPtySession 实现同一个 ShellSession 协议（BasePtySession 哨兵主循环
复用），差别只在字节层：ConPTY 没有非阻塞 fd，用线程阻塞读并经线程安全
队列投递给事件循环。命令包装用 PowerShell 语法覆写 _wrap。

仅 Windows 可导入；Linux/macOS 路径不经过本模块。
"""

from __future__ import annotations

import asyncio
import threading

from .shell_session import BasePtySession


class WinPtySession(BasePtySession):
    def __init__(self, shell: str | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._shell = shell or "powershell.exe -NoLogo"
        self._proc = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[bytes] | None = None
        self._reader: threading.Thread | None = None

    # --- PowerShell 哨兵包装（与 wrap_command 的 POSIX 版对应）---
    def _wrap(self, command: str) -> str:
        one_line = command.replace("\n", " ; ").replace("\r", " ")
        # 结尾必须 \r：PSReadLine 把 LF 当 Shift-Enter（编辑缓冲区换行、
        # 出 >> 续行提示），命令不会被提交执行
        # 退出码：先清 $LASTEXITCODE——原生命令码只在它非空时取（cmd /c
        # exit 3 时 $? 也是 False，不能用它兜底）；为空说明只跑了 cmdlet，
        # 用 $? 判成败。try/finally 让正常路径的 END 一定输出
        return (
            "$LASTEXITCODE = $null; Write-Output '__OT_BEGIN__'; "
            "try { " + one_line + " } finally { "
            "$otc = if ($null -eq $LASTEXITCODE) { "
            "if ($?) { 0 } else { 1 } } else { $LASTEXITCODE }; "
            "Write-Output ('__OT_END__' + $otc + '__'"
            " + (Get-Location).Path + '__') }\r"
        )

    def _wrap_passthrough(self, command: str, marker: str) -> str:
        one_line = command.replace("\n", " ; ").replace("\r", " ")
        # 与 POSIX 版一致：交互程序退出后输出带随机 marker 的哨兵；
        # $LASTEXITCODE 为空说明只跑了 cmdlet/无原生命令退出码，按 0 处理
        return (one_line + " ; Write-Output ('" + marker + "_' + "
                "$(if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 })"
                " + '__')\r")

    # --- 生命周期 ---
    async def start(self) -> None:
        from winpty import PtyProcess

        self._proc = PtyProcess.spawn(
            self._shell.split(), dimensions=(40, 120))
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue()
        self._reader = threading.Thread(
            target=self._pump, name="ot-conpty-reader", daemon=True)
        self._reader.start()
        await self._quiet()  # 等 PowerShell 横幅/提示符排空

    async def _quiet(self) -> None:
        try:
            if not await self._read_some(10.0):
                return
            while True:
                await self._read_some(0.5)
        except (asyncio.TimeoutError, OSError):
            pass

    def _pump(self) -> None:
        """专职读者线程：ConPTY 无非阻塞读，阻塞读并投递进事件循环。"""
        assert self._loop is not None and self._queue is not None
        while self._proc is not None:
            try:
                data = self._proc.read(65_536)
            except (EOFError, OSError):
                self._loop.call_soon_threadsafe(self._queue.put_nowait, b"")
                return
            if not data:
                continue
            payload = data if isinstance(data, bytes) else \
                data.encode("utf-8", errors="replace")
            self._loop.call_soon_threadsafe(self._queue.put_nowait, payload)

    # --- 字节层 ---
    async def _write_raw(self, data: bytes) -> None:
        # 直写，不排空：交互按键（send_raw）走这里，排空会与 pump 的
        # 读者线程抢读、吞掉提示符/OSC 标记字节，还引入固定 200ms 延迟。
        # 哨兵批写入需要静默的场景由 drain_to_silence()（仅批路径调用）承担。
        if self._proc is not None:
            self._proc.write(data.decode("utf-8", errors="replace"))

    async def drain_to_silence(self, quiet: float = 0.2) -> None:
        # 哨兵批写入前：排空到静默，避免回显/重绘把哨兵锚点搞乱
        while True:
            try:
                chunk = await self._read_some(quiet)
            except (asyncio.TimeoutError, OSError):
                break
            if not chunk:
                break

    async def _read_some(self, idle_timeout: float) -> bytes:
        assert self._queue is not None
        return await asyncio.wait_for(self._queue.get(), timeout=idle_timeout)

    async def _interrupt(self) -> None:
        if self._proc is not None:
            try:
                self._proc.sendintr()  # Ctrl-C
            except OSError:
                pass

    async def _recover_connection(self) -> bool:
        """本地 shell 死掉：关掉重启，语义等同"重新连上"。"""
        await self.close()
        try:
            await self.start()
            await self._notify_reconnect()
            return True
        except OSError:
            return False

    async def _still_alive(self) -> bool:
        """超时 Ctrl-C 后 shell 通常还活着（PS 的中断只作废当前行，
        finally 里的 END 哨兵不会输出）。发一条探针命令确认，避免整个
        会话被无谓重启、cd 等状态丢失。"""
        probe = "Write-Output ('ot-al' + 'ive-ok')\r"
        try:
            await self._write_raw(probe.encode())
        except (ConnectionError, EOFError, OSError):
            return False
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 5
        buf = b""
        while loop.time() < deadline:
            try:
                chunk = await self._read_some(min(2.0, deadline - loop.time()))
            except asyncio.TimeoutError:
                continue  # 高负载下回显可能迟于单次 2s 读：等满 5s 总预算
            except (ConnectionError, EOFError, OSError):
                return False
            # 探针命令回显里是 'ot-al'+'ive-ok' 拆开的，只有真实输出才出现
            # 连续的 ot-alive-ok；标记可能跨 chunk 拆分，累积后再判断
            buf += chunk
            if b"ot-alive-ok" in buf:
                return True
        return False

    async def resize(self, rows: int, cols: int) -> None:
        if self._proc is not None:
            try:
                self._proc.setwinsize(rows, cols)
            except OSError:
                pass

    async def send_raw(self, data: bytes) -> None:
        await self._write_raw(data)

    async def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None:
            try:
                proc.terminate(force=True)
            except OSError:
                pass
        # 读者线程随 proc 关闭读到 EOFError 自行退出
