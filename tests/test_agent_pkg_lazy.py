"""agent 包再导出不得击穿惰性 AI 栈（终审 Critical 修复的回潮护栏）。

spec 的启动预算依赖：agent/runner.py（deepagents/langchain 全家桶，
导入约 4.6s）只在 _load_agent_stack 需要时导入。包 __init__ 若急切
导入 runner，任何 core 侧 `from ..agent.sysprobe import ...` 都会把
AI 栈拖进进程——用子进程断言 sys.modules 干净。agent/backend.py 是
deepagents 适配器本身（旧代码即顶层导入 deepagents），不在断言内。
"""
import subprocess
import sys

CODE = (
    "import sys\n"
    "import openterminal.agent.sysprobe\n"
    "import openterminal.agent.token_est\n"
    "bad = [m for m in sys.modules if m == 'deepagents' "
    "or m.startswith('deepagents.') or m == 'langchain_anthropic' "
    "or m.startswith('langchain.')]\n"
    "assert not bad, bad\n"
    "print('ok')\n"
)


def test_agent_pkg_import_does_not_pull_ai_stack():
    r = subprocess.run([sys.executable, "-c", CODE], capture_output=True,
                       text=True, timeout=120)
    assert r.returncode == 0, r.stderr


def test_agent_pkg_lazy_reexports_still_work():
    # PEP 562 惰性再导出：旧路径 `from openterminal.agent import X` 可用
    from openterminal.agent import AGENT_STALL_TIMEOUT, TaskRunner  # noqa: F401
    import openterminal.agent as amod
    import openterminal.agent.runner as runner
    assert amod.TaskRunner is runner.TaskRunner
