"""session 域（阶段二 Task 12 重组）。

base.py——ShellSession 协议、BasePtySession、命令包装/捕获切片
（BEGIN/END 标记协议）；local_posix.py（仅 POSIX 可导入：fcntl）/
local_win.py（仅 Windows 可导入：pywinpty）/ssh.py——三种 PTY 会话实现。

本 __init__ 只再导出 base 的公开名（对应旧 ``shell_session`` 模块的
命名空间）；平台专属会话类各居其模块，旧路径 local_pty / local_win /
ssh_pty 壳直连对应子模块——不可在包级急切导入平台专属子模块
（Windows 上 fcntl 不存在，旧代码即靠「从不顶层导入 local_pty」存活）。
"""

from .base import (  # noqa: F401
    BEGIN_MARKER, END_MARKER, BasePtySession, CommandResult, ShellSession,
    _PASSWORD_PROMPT_RE, _needs_password_prompt, slice_capture,
    truncate_output, wrap_command, wrap_passthrough,
)
