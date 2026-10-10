"""frontend 域（阶段二 Task 15 重组）。

term.py——终端交互前端（TermFrontend/CliCore/CliRenderer，输入捕获与
状态栏）；approval.py——审批决定归一化；render.py——Console 与命令/
结果渲染；banner.py——启动横幅；taskview.py——任务呈现（TaskPresenter/
ThinkingStream）；headless.py——无头执行模式（退出码约定/目标解析）。
本 __init__ 再导出旧六模块全部公开名，旧 import 路径
（``from openterminal.term_frontend import ...`` 等）不因拆包而变。
"""

from .approval import decision_for_choice, edit_decision, reclassify_edited  # noqa: F401
from .banner import print_banner  # noqa: F401
from .headless import (  # noqa: F401
    DEFAULT_EXEC_TIMEOUT, EXIT_APPROVAL_REQUIRED, EXIT_CONNECT_FAILED,
    EXIT_DENIED, EXIT_HOST_KEY, EXIT_TARGET_NOT_FOUND, EXIT_USAGE,
    all_targets, resolve_target, run_headless,
)
from .render import console, print_answer, print_command, print_denied, \
    print_summary  # noqa: F401
from .taskview import TaskPresenter, ThinkingStream  # noqa: F401
from .term import CliCore, CliRenderer, TermFrontend  # noqa: F401
