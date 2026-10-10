"""openterminal.core——编排层子包（阶段一终态）。

PipelineCore 组合根居 pipeline.py；组件（auth/exec_events/hook_gate/
cmdset_runner/ai_flow/pump）、消息协议（messages）、嵌套跟踪（nested_ssh）
平铺本包。此处显式再导出公开 API；未列出的符号（build_agent 占位、
SUBMIT_FALLBACK_DELAY、_PW_*、load_password 等历史 monkeypatch/直读目标）
经 PEP 562 回退转发 pipeline 模块。_CoreBridge 把对包属性的赋值同步转发
pipeline——web/worker.py 的 _PatchBridge 经此二跳落到实现模块（测试
monkeypatch wmod.X 的实现端可见性，阶段一验收硬线）。
"""

import sys as _sys

from .messages import (
    CHANNEL_DEAD_EC, CHANNEL_DEAD_MSG, ClientMsg, CommandResult,
    InteractiveRunner, PasswordCancelled, ServerMsg,
)
from .pipeline import CorePresenter, PipelineCore


def __getattr__(name):
    # 回退转发：实现全局现居 pipeline 模块
    from . import pipeline as _impl
    try:
        return getattr(_impl, name)
    except AttributeError:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


class _CoreBridge(type(_sys.modules[__name__])):
    """补丁桥：对包属性的赋值同步转发到实现模块 pipeline。"""

    def __setattr__(cls, name, value):
        super().__setattr__(name, value)
        if not name.startswith("__"):
            from . import pipeline as _impl
            if hasattr(_impl, name):
                setattr(_impl, name, value)


_sys.modules[__name__].__class__ = _CoreBridge
