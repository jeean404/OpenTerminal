"""持久 shell 会话接口与哨兵捕获主循环（local / ssh 共用）。"""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from typing import Callable, Protocol

BEGIN_MARKER = "__OT_BEGIN__"
END_MARKER = "__OT_END__"
_BEGIN_RE = re.compile(rb"__OT_BEGIN__\r?\n")
_END_RE = re.compile(rb"__OT_END__(-?\d+)__(.*)__\r?\n")
_ANSI_RE = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")

# 中文提示符（密码：/口令：）单独以 str 编码拼进 bytes 正则（bytes 字面量
# 不能含非 ASCII）
_PASSWORD_PROMPT_RE = re.compile(
    rb"(\[sudo\] password for |'s password:|\([^)\r\n]{1,80}\)\s*password:"
    rb"|^password:|" + "密码[:：]|口令[:：]".encode() + rb")",
    re.IGNORECASE | re.MULTILINE,
)
_PASSWORD_NEEDING_PREFIXES = {"sudo", "su", "ssh", "scp", "rsync"}


def _needs_password_prompt(command: str) -> bool:
    head = command.strip().split()[0] if command.strip() else ""
    return os.path.basename(head) in _PASSWORD_NEEDING_PREFIXES


@dataclass
class CommandResult:
    output: str
    exit_code: int
    truncated: bool
    cwd: str
    reconnected: bool = False


class ShellSession(Protocol):
    cwd: str

    async def start(self) -> None: ...
    async def run(
        self,
        command: str,
        *,
        timeout: int | None = None,
        on_output: Callable[[str], None] | None = None,
    ) -> CommandResult: ...
    async def send_raw(self, data: bytes) -> None: ...
    async def resize(self, rows: int, cols: int) -> None: ...
    async def close(self) -> None: ...


def wrap_command(command: str) -> str:
    """把用户命令包进 BEGIN/END 哨兵的单行复合命令。

    必须是单行：多行输入可能被会读 stdin 的命令（如 cat）偷吃掉。
    """
    one_line = command.replace("\n", " ; ").replace("\r", " ")
    return (
        f"printf '{BEGIN_MARKER}\\n'; {one_line}; "
        f"printf '{END_MARKER}%s__%s__\\n' \"$?\" \"$PWD\"\n"
    )


def wrap_passthrough(command: str, marker: str) -> str:
    """交互式内联直通的单行包装：命令 ; printf 随机哨兵（带退出码）。

    与 wrap_command 的差别：不打 BEGIN 标记（活块从命令回显起显示），哨兵用
    调用方给的随机 marker。sudo su - / vim 等退出后 shell 会接着执行 printf，
    worker 在字节流里扫描它即可自动检测「交互命令已结束」并取到退出码。
    """
    one_line = command.replace("\n", " ; ").replace("\r", " ")
    return f"{one_line} ; printf '{marker}_%s__\\n' \"$?\"\r"


def _clean(raw: bytes) -> str:
    raw = _ANSI_RE.sub(b"", raw)
    return raw.decode("utf-8", errors="replace").replace("\r", "").rstrip("\n")


def slice_capture(data: bytes) -> tuple[str, int, str] | None:
    """从 PTY 字节流里切出（命令输出, exit_code, cwd）；哨兵未到齐返回 None。"""
    # 必须锚定"标记 + 真实换行"：tty 回显的命令行里也含字面 __OT_BEGIN__\n，
    # 但那是引号内的反斜杠+n 两字符，后面并非真正的 CR/LF（真实 printf 输出
    # 在 cooked PTY 上是 __OT_BEGIN__\r\n）。
    m_begin = _BEGIN_RE.search(data)
    if not m_begin:
        return None
    body_start = m_begin.end()
    end_idx = data.find(END_MARKER.encode(), body_start)
    if end_idx < 0:
        return None
    line_end = data.find(b"\n", end_idx)
    # 切片右端是排他的，必须把行尾 \n 包进窗口，否则要求 \r?\n 收尾的
    # _END_RE 永不匹配。
    search_end = line_end + 1 if line_end > 0 else len(data)
    m = _END_RE.search(data[end_idx:search_end])
    if not m:
        return None
    output = _clean(data[body_start:end_idx])
    cwd = m.group(2).decode("utf-8", errors="replace")
    return output, int(m.group(1)), cwd


def truncate_output(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    head = text[: limit // 2]
    tail = text[-limit // 2 :]
    return f"{head}\n\n... 输出已截断（中间省略）...\n{tail}", True


class BasePtySession:
    """子类提供字节级读写，本类实现哨兵主循环、超时、截断、断线恢复。"""

    def __init__(self, *, default_timeout: int = 120, max_output_bytes: int = 102_400):
        self.cwd = ""
        self._buf = bytearray()
        self._default_timeout = default_timeout
        self._max_output = max_output_bytes
        # 一个 PTY 就是一条交互式 shell：模型一轮并行发起多个 execute 时，
        # langgraph 会并发调用 run()，而哨兵捕获/cwd 跟踪都要求命令严格串行，
        # 否则两条命令的写入与回读互相截胡（命令拼坏、输出互吞、超时重置）。
        self._run_lock = asyncio.Lock()
        # 断线自动重连成功后的回调（async def () -> None），worker 用于把
        # 历史命令重新注入新 shell；None = 无操作。
        self.on_reconnect = None

    def _wrap(self, command: str) -> str:
        """把命令包进哨兵；POSIX shell 语法，PowerShell 会话覆写此方法。"""
        return wrap_command(command)

    def _wrap_passthrough(self, command: str, marker: str) -> str:
        """交互式内联直通包装；PowerShell 会话覆写此方法。"""
        return wrap_passthrough(command, marker)

    # --- 子类实现 ---
    async def _write_raw(self, data: bytes) -> None:
        raise NotImplementedError

    async def drain_to_silence(self, quiet: float = 0.2) -> None:
        """排空积压输出直到静默（默认无操作，本地会话覆写）。

        只在**哨兵批写入前**调用：本地 tty 回显/重绘会把哨兵锚点搞乱
        （zle cooked 模式整行回显、ConPTY 提示符重绘）。交互按键
        （send_raw）绝不能排空——那会与 _pump_loop 抢读、吞掉提示符/
        OSC 标记字节，还给每次按键加固定 quiet 延迟。
        """
        return

    async def _read_some(self, idle_timeout: float) -> bytes:
        raise NotImplementedError

    async def _interrupt(self) -> None:
        raise NotImplementedError

    async def recover(self) -> bool:
        """外部（worker 键盘路径）触发的断线恢复；成功时已回调 on_reconnect。"""
        return await self._recover_connection()

    async def _recover_connection(self) -> bool:
        return False

    async def _notify_reconnect(self) -> None:
        """重连成功后通知 worker（历史注入等）；回调异常不外泄。"""
        cb = self.on_reconnect
        if cb is None:
            return
        try:
            await cb()
        except Exception:  # noqa: BLE001 - 钩子失败不能打断恢复流程
            pass

    async def _still_alive(self) -> bool:
        """超时中断后哨兵缺失时的存活探测；默认不探测（视为已死）。

        PowerShell 的 Ctrl-C 会中止整行提交、finally 里的 END 哨兵也不
        输出，但 shell 本身还活着——ConPTY 会话覆写此方法保住会话状态。
        """
        return False

    # --- 主循环 ---
    async def run(
        self,
        command: str,
        *,
        timeout: int | None = None,
        on_output: Callable[[str], None] | None = None,
    ) -> CommandResult:
        async with self._run_lock:
            return await self._run_locked(
                command, timeout=timeout, on_output=on_output)

    async def _run_locked(
        self,
        command: str,
        *,
        timeout: int | None = None,
        on_output: Callable[[str], None] | None = None,
    ) -> CommandResult:
        effective = timeout or self._default_timeout
        self._buf.clear()
        tee_started = False
        deadline = asyncio.get_running_loop().time() + effective
        try:
            # 哨兵批写入前排空到静默（本地会话：防回显/重绘错位锚点；
            # SSH 无此问题，基类默认 no-op）。交互按键不经过这里。
            await self.drain_to_silence()
            await self._write_raw(self._wrap(command).encode())
        except (ConnectionError, EOFError):
            if await self._recover_connection():
                return self._reconnected_result()
            raise

        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return await self._handle_timeout()
            try:
                chunk = await self._read_some(min(5.0, remaining))
            except asyncio.TimeoutError:
                continue
            except (ConnectionError, EOFError):
                if await self._recover_connection():
                    return self._reconnected_result()
                raise
            if not chunk:
                if await self._recover_connection():
                    return self._reconnected_result()
                raise ConnectionError("shell 通道已关闭")

            prev_len = len(self._buf)
            self._buf.extend(chunk)
            if on_output:
                # 实时回显：从真实 BEGIN 标记行起、到 END 止，原样 tee（保留颜色）。
                # 用 _BEGIN_RE（标记+真实换行）锚定，跳过命令行 tty 回显。
                if not tee_started:
                    m_begin = _BEGIN_RE.search(self._buf)
                    if m_begin:
                        tee_started = True
                        head = bytes(self._buf[m_begin.end() :])
                        if END_MARKER.encode() in head:
                            head = head[: head.find(END_MARKER.encode())]
                        if head:
                            on_output(head.decode("utf-8", errors="replace"))
                else:
                    view = chunk
                    if END_MARKER.encode() in view:
                        view = view[: view.find(END_MARKER.encode())]
                    if view:
                        on_output(view.decode("utf-8", errors="replace"))

            sliced = slice_capture(bytes(self._buf))
            if sliced is not None:
                output, code, cwd = sliced
                output, truncated = truncate_output(output, self._max_output)
                if not output:
                    output = "<no output>"
                self.cwd = cwd or self.cwd
                return CommandResult(output=output, exit_code=code,
                                     truncated=truncated, cwd=self.cwd)

            # 兜底：sudo/su/ssh 出现密码提示 → 提前中断，别等 120s 超时丢会话。
            # 仅当提示串位于缓冲末尾（真实提示阻塞等待输入、其后无换行）才触发，
            # 避免误杀输出里恰好含 password 字样的正常命令。
            m = _PASSWORD_PROMPT_RE.search(self._buf)
            if m and b"\n" not in self._buf[m.end():] and _needs_password_prompt(command):
                await self._interrupt()
                hint = (
                    "检测到密码/凭据提示：该命令需要交互输入密码，命令模式无法完成。\n"
                    "请按 Ctrl+R 进入终端透传模式手动执行（Web 端切换透传模式），"
                    "或先执行 sudo -v 刷新凭据后再试。"
                )
                if on_output is not None:
                    on_output(hint + "\n")
                return CommandResult(
                    output=hint, exit_code=130, truncated=False, cwd=self.cwd,
                )

            # 防止异常输出无限占内存：保留尾部，哨兵在尾部 64KB 内必能再次出现
            if len(self._buf) > max(self._max_output * 4, 1_000_000):
                del self._buf[: len(self._buf) - 262_144]

    def _reconnected_result(self) -> CommandResult:
        return CommandResult(
            output="[ssh] 连接中断后已自动重连；为避免非幂等重复执行，原命令未重跑，"
                   "请确认后重试。",
            exit_code=1,
            truncated=False,
            cwd=self.cwd,
            reconnected=True,
        )

    async def _handle_timeout(self) -> CommandResult:
        # 先 Ctrl-C 给命令优雅退出的机会，再等 3 秒哨兵
        await self._interrupt()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 3
        while loop.time() < deadline:
            try:
                self._buf.extend(await self._read_some(deadline - loop.time()))
            except asyncio.TimeoutError:
                break
            except (ConnectionError, EOFError):
                break
            if slice_capture(bytes(self._buf)) is not None:
                output, code, cwd = slice_capture(bytes(self._buf))  # type: ignore[misc]
                self.cwd = cwd or self.cwd
                return CommandResult(
                    output=f"{output}\n\n[命令在 {self._default_timeout}s 后被中断 (Ctrl-C)",
                    exit_code=130, truncated=False, cwd=self.cwd,
                )
        if await self._still_alive():
            return CommandResult(
                output=f"[命令在 {self._default_timeout}s 后被中断 (Ctrl-C)，"
                       "shell 仍存活，会话状态保留。]",
                exit_code=130, truncated=False, cwd=self.cwd,
            )
        if await self._recover_connection():
            return self._reconnected_result()
        return CommandResult(
            output=f"Error: 命令超时（{self._default_timeout}s），shell 已重置，会话状态丢失。",
            exit_code=124, truncated=False, cwd=self.cwd,
        )
