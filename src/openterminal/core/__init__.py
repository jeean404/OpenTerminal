"""编排层子包。公开 API 经此再导出（最终由 pipeline.py 提供）。

阶段一过渡：原 core.py 的全部内容现居 _core_impl.py（Task 9 瘦身后消失）。
包在这里**惰性**转发全部公开符号（PEP 562 __getattr__），旧 import 路径
（openterminal.core）不变。惰性是必须的：_core_impl 模块级导入
``.core.messages`` 等子模块会先触发本包初始化，若这里再模块级转发回
_core_impl 即成环（首次 ``import openterminal._core_impl`` 直接
ImportError）。子模块（messages/auth/exec_events/nested_ssh）不受
__getattr__ 影响：from-import 对未知属性抛 AttributeError 后由导入
系统按子模块解析。
"""

import sys as _sys


def __getattr__(name):
    # 惰性转发：首次属性访问才拉起 _core_impl（打破初始化环）
    from .. import _core_impl as _impl
    try:
        return getattr(_impl, name)
    except AttributeError:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


class _CoreBridge(type(_sys.modules[__name__])):
    """补丁桥：对包属性的赋值同步转发到实现模块 _core_impl。

    阶段一过渡件：测试历史上 monkeypatch ``openterminal.core.X``（或经
    web.worker 的桥二跳到达），包化后 PipelineCore 的全局解析在
    _core_impl，赋值必须走同一通道落到实现模块（web/worker.py 的
    _PatchBridge 是同款先例）。Task 9 后本桥随 _core_impl 一起删除。
    """

    def __setattr__(cls, name, value):
        super().__setattr__(name, value)
        if not name.startswith("__"):
            from .. import _core_impl as _impl
            if hasattr(_impl, name):
                setattr(_impl, name, value)


_sys.modules[__name__].__class__ = _CoreBridge
