"""AI 行处理/任务（core/ai_flow.py AiFlow）域测试：组件冒烟。

（Task 10 拆分：brief 的域文件清单未列 ai 域，此文件承接
test_core_components 溶解时的 AiFlow 冒烟用例——只搬不改断言。）
"""
from tests.core_fakes import FakeCore


def test_aiflow_owns_state():
    from openterminal.core.ai_flow import AiFlow
    a = AiFlow(FakeCore())
    for attr in ("_ai_task", "_ai_ping_at", "_ai_queue", "_rescue_open",
                 "_rescue_ctx", "_fallback_task", "_suppress_ai_report"):
        assert hasattr(a, attr), attr


def test_core_lazy_ai_property():
    from openterminal.core.pipeline import PipelineCore
    core = PipelineCore.__new__(PipelineCore)
    assert core.ai is core.ai
