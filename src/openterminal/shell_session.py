"""旧路径壳（阶段二 Task 12）：实现已迁至 session/base.py。"""

from .session.base import (  # noqa: F401
    BEGIN_MARKER, END_MARKER, BasePtySession, CommandResult, ShellSession,
    _ANSI_RE, _BEGIN_RE, _END_RE, _PASSWORD_PROMPT_RE, _clean,
    _needs_password_prompt, slice_capture, truncate_output, wrap_command,
    wrap_passthrough,
)
