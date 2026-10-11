"""把 ShellSession 适配成 deepagents 的 SandboxBackendProtocol。"""

from __future__ import annotations

import asyncio
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


class PtyShellBackend(LocalShellBackend):
    """文件操作沿用 LocalShellBackend；execute 走持久 PTY 会话。

    SSH 模式下注意：内置文件工具作用于本机，Agent 系统提示词中已要求
    远程文件操作一律走 execute。
    """

    def __init__(self, session: ShellSession, root_dir: str | None = None) -> None:
        super().__init__(root_dir=root_dir or session.cwd or None, inherit_env=True)
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
        if result.cwd:
            self.cwd = Path(result.cwd)
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
