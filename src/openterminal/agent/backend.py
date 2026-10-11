"""把 ShellSession 适配成 deepagents 的 SandboxBackendProtocol。"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from pathlib import Path

from deepagents.backends import LocalShellBackend
from deepagents.backends.protocol import (
    DeleteResult,
    EditResult,
    ExecuteResponse,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)

from ..session.base import ShellSession

# 带盘符的路径段（`C:`、`/C:/...`、`\\?\C:\...`）：deepagents 的路径拼接遇到它
# 会换锚，把结果带出 root
_DRIVE_SEG_RE = re.compile(r"(?:^|[/\\])[A-Za-z]:")


def _local_root(root_dir: str | None, session: ShellSession,
                remote_target: bool) -> Path:
    """read_file/write_file 等文件工具的**本机**根目录（虚拟路径 /x 的锚点）。

    只有本机真实存在的绝对目录才配当根：SSH（含嵌套 ssh）会话的 cwd 是远端
    路径，拿来当根会在本机解析出影子目录——Windows 上 ``Path("/tmp")`` 是无
    盘符路径，resolve 出 ``<当前盘>:\\tmp``——甚至按远端路径树在本机凭空
    mkdir。远端目标一律回退到用户主目录：「下载到我本机」的落点，且
    /Downloads、/Desktop、/Documents 都在根内可写。
    """
    if root_dir is not None:
        # 显式指定照办（测试/调用方自知其意），只做规范化，不改语义
        return Path(root_dir).expanduser().resolve()
    cand = "" if remote_target else (getattr(session, "cwd", "") or "")
    if cand:
        try:
            p = Path(cand).expanduser()
            if p.is_absolute() and p.is_dir():
                return p.resolve()
        except (OSError, RuntimeError, ValueError):
            pass
    return Path.home()


class PtyShellBackend(LocalShellBackend):
    """文件操作沿用 LocalShellBackend；execute 走持久 PTY 会话。

    文件根是**本机**目录，构造时定死、此后不再跟随 shell 的 cd：虚拟路径
    /x 的含义必须全程稳定；且 execute 回报的 cwd 可能来自远端 shell，覆盖根
    会把根打成无盘符/远端路径，之后所有文件工具在 ``relative_to`` 判据下集体
    报「outside root directory」（真机「write_file ×失败」根因）。

    SSH 模式下注意：内置文件工具作用于本机，Agent 系统提示词中已要求
    远程文件操作一律走 execute。
    """

    def __init__(self, session: ShellSession, root_dir: str | None = None, *,
                 remote_target: bool = False) -> None:
        super().__init__(root_dir=_local_root(root_dir, session, remote_target),
                         inherit_env=True)
        self.session = session
        # CLI 在任务开始前设置、结束后清空（rich console 实时打印）
        self.on_output: Callable[[str], None] | None = None
        # 命令实际开始执行（审批通过之后）/结束（带 exit code）时的同步回调，
        # 供展示层打印“执行”面板、按成败切换详述模式
        self.on_start: Callable[[str], None] | None = None
        self.on_finish: Callable[[str, int], None] | None = None
        # 命令注入前的异步门闩：worker 用它等前端把流底分析卡结账垫满
        # （ai_boundary/boundary_settled 往返），保证命令回显在 PTY 里落在
        # pad 空行之后——回显先于空行进缓冲会把卡的连续空白区打断=永久盖帽
        self.on_boundary: Callable[[], Awaitable[None]] | None = None

    def _resolve_path(self, key: str) -> Path:
        """越界路径判据补一层：带盘符的段直接判越界。

        deepagents 的 `root / key` 拼接遇 `C:/...` 会换锚跳走，工具层
        validate_path 只挡 `^[a-zA-Z]:` 开头，挡不住 `/C:/Users/x` 这类「过了
        校验、解析却越界」的路径（docs/bug.md 上传场景那类）。根落在 C: 盘时
        它会真逃出沙箱——实测能列出/写入真实桌面。这里与越界路径同口径拒绝，
        由调用方包成 error 结果回模型。
        """
        if _DRIVE_SEG_RE.search(str(key)):
            raise ValueError(
                f"Path:{key} outside root directory: {self.cwd}")
        return super()._resolve_path(key)

    # --- 文件操作：路径 ValueError 不上抛，包成 error 结果 ---
    # deepagents 的 FilesystemBackend._resolve_path 对越界/穿越路径抛
    # ValueError，而 read/write 等只兜 (OSError, RuntimeError)；工具层的
    # validate_path 又拦不住 `/C:/...` 这类「过了校验、解析却越界」的路径
    # （Windows 桌面文件上传场景的「任务失败：ValueError」根因）。backend
    # 契约是返回 error 结果而非抛异常——这里补上，模型看到错误文本后自行
    # 换方案；其余未预期异常交给 ToolErrorRetryMiddleware 统一收口。

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        try:
            return super().read(file_path, offset=offset, limit=limit)
        except ValueError as e:
            return ReadResult(error=f"Error reading file '{file_path}': {e}")

    def write(self, file_path: str, content: str) -> WriteResult:
        try:
            return super().write(file_path, content)
        except ValueError as e:
            return WriteResult(error=f"Error writing file '{file_path}': {e}")

    def edit(self, file_path: str, old_string: str, new_string: str,
             replace_all: bool = False) -> EditResult:
        try:
            return super().edit(file_path, old_string, new_string, replace_all)
        except ValueError as e:
            return EditResult(error=f"Error editing file '{file_path}': {e}")

    def delete(self, file_path: str) -> DeleteResult:
        try:
            return super().delete(file_path)
        except ValueError as e:
            return DeleteResult(error=f"Error deleting '{file_path}': {e}")

    def ls(self, path: str) -> LsResult:
        try:
            return super().ls(path)
        except ValueError as e:
            return LsResult(error=f"Cannot list '{path}': {e}", entries=None)

    def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        try:
            return super().glob(pattern, path=path)
        except ValueError as e:
            return GlobResult(error=f"Error globbing '{pattern}': {e}")

    def grep(self, pattern: str, path: str | None = None, glob: str | None = None,
             *, max_count: int | None = None, context_lines: int = 0) -> GrepResult:
        try:
            return super().grep(pattern, path=path, glob=glob,
                                max_count=max_count, context_lines=context_lines)
        except ValueError as e:
            return GrepResult(error=f"Error searching '{pattern}': {e}", matches=[])

    async def aexecute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        if self.on_boundary is not None:
            await self.on_boundary()
        if self.on_start is not None:
            self.on_start(command)
        try:
            result = await self.session.run(
                command, timeout=timeout, on_output=self.on_output
            )
        except BaseException:
            # 取消/异常路径也要收束输出块括号（term_close），否则前端
            # _cmdOut 悬空，后续终端字节会被误写进僵尸输出块
            if self.on_finish is not None:
                self.on_finish(command, 130)
            raise
        # 这里刻意不动 self.cwd：文件根构造时定死（见类文档）。曾经的
        # `self.cwd = Path(result.cwd)` 会把远端 shell 的 cwd（/tmp 这类无盘符
        # 路径）灌成本机根，随后每个文件工具都因 relative_to 判据失败而报
        # 「outside root directory: \\tmp」——真机 write_file 连续 ×失败 的根因。
        if self.on_finish is not None:
            self.on_finish(command, result.exit_code)
        return ExecuteResponse(
            output=result.output,
            exit_code=result.exit_code,
            truncated=result.truncated,
        )

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.aexecute(command, timeout=timeout))
        raise RuntimeError("同步 execute() 不能在事件循环内调用，请用 aexecute()")
