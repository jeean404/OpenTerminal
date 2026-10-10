"""核心测试脚手架（Task 10 集中）：FakeCore / _bare_core。"""

from openterminal.core import PipelineCore
from openterminal.core.nested_ssh import NestedSshTracker


class FakeCore:
    """最小鸭子：NestedSshTracker / 组件冒烟经 core 读跨域状态。"""
    _open_cmds: dict = {}
    _open_cmd_at: dict = {}
    _last_mark_at: float = 0.0
    _target_host: str = ""
    _pending_approval = None   # _shell_exit_window 弱匹配窗口判据


def _bare_core(**attrs) -> PipelineCore:
    """绕过 __init__ 的最小核心对象（只挂被测路径所需的属性）。"""
    c = object.__new__(PipelineCore)
    for k, v in attrs.items():
        setattr(c, k, v)
    return c
