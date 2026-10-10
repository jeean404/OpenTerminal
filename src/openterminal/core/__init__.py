"""编排层子包。公开 API 经此再导出（最终由 pipeline.py 提供）。

阶段一过渡：原 core.py 的全部内容现居 _core_impl.py（Task 9 瘦身后消失）。
包在这里转发全部公开符号，旧 import 路径（openterminal.core）不变——
Python 的包与同名模块冲突时包胜出，term_frontend/web.worker 等指向
``openterminal.core`` 的 import 无需改动。
"""

# 阶段一过渡：转发 _core_impl 的全部公开符号
from .._core_impl import *  # noqa: F401,F403
from .._core_impl import (  # noqa: F401 - 显式列出测试引用的符号
    CMDSET_ECHO_TIMEOUT,
    CMDSET_HOOK_WAIT,
    CMDSET_PROMPT_TIMEOUT,
    CMDSET_QUIET,
    CMDSET_RESUME_QUIET,
    SUBMIT_FALLBACK_DELAY,
    ClientMsg,
    InteractiveRunner,
    PasswordCancelled,
    PipelineCore,
    ServerMsg,
    _CMDSET_CONFIRM_RE,
    _CMDSET_DONE_RE,
    _CMDSET_PROMPT_RE,
    _CMDSET_SECRET_RE,
    _CS_PROMPT_ID_RE,
    _PROBE_TIMEOUT,
    _PW_HOLD_RELEASE,
    _PW_MODAL_DISMISS,
    _PW_REMEMBER_DELAY,
    _PW_VERIFY_TIMEOUT,
    build_agent,
    build_chat_model,
)

import sys as _sys

from .. import _core_impl as _impl


class _CoreBridge(type(_sys.modules[__name__])):
    """补丁桥：对包属性的赋值同步转发到实现模块 _core_impl。

    阶段一过渡件：测试历史上 monkeypatch ``openterminal.core.X``（或经
    web.worker 的桥二跳到达），包化后 PipelineCore 的全局解析在
    _core_impl，赋值必须走同一通道落到实现模块（web/worker.py 的
    _PatchBridge 是同款先例）。Task 9 后本桥随 _core_impl 一起删除。
    """

    def __setattr__(cls, name, value):
        super().__setattr__(name, value)
        if not name.startswith("__") and hasattr(_impl, name):
            setattr(_impl, name, value)


_sys.modules[__name__].__class__ = _CoreBridge
