"""shell 域（阶段二 Task 13 重组）。

integration.py——shell 集成脚本（bash/zsh/powershell 注入）、exec/探针/
内部行判别与 StreamRouter 输出分流；cmdset.py——连接后命令集的内联密码
抽取与 @引用解析。
本 __init__ 再导出两模块全部公开名，旧 import 路径
（``from openterminal.shell_integration import ...`` /
``from openterminal.cmdset import ...``）不因拆包而变。
"""

from .cmdset import extract_inline_secrets, resolve_answer  # noqa: F401
from .integration import (  # noqa: F401
    EXEC_PREFIX, KIND_AI, KIND_CMD, KIND_EXEC, PROBE_TAG, StreamRouter,
    agent_exec_line, build_script, history_inject_line, history_quiet_line,
    injection_line, injection_lines, is_internal_line, parse_probe,
    probe_command, strip_ansi, toggle_line,
)
