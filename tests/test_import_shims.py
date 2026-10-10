"""旧 import 路径全部经再导出壳保持可用（垫片脚本/外部引用依赖）。

例外：openterminal.local_pty（→ session/local_posix.py）顶层 import
fcntl，仅 POSIX 可导入——壳忠实复刻旧行为，Windows 上断言其抛
ModuleNotFoundError（守住「不可静默变为可导入」的反向不变量）。
"""
import importlib
import sys

SHIMS = [
    "openterminal.core", "openterminal.term_frontend",
    "openterminal.shell_integration", "openterminal.connections",
    "openterminal.connections_db", "openterminal.secrets_store",
    "openterminal.shell_session",
    "openterminal.local_win", "openterminal.ssh_pty", "openterminal.cmdset",
    "openterminal.history_db", "openterminal.transcript", "openterminal.agent",
    "openterminal.backend", "openterminal.token_est", "openterminal.sysprobe",
    "openterminal.approval", "openterminal.render", "openterminal.banner",
    "openterminal.taskview", "openterminal.headless",
]


def test_all_legacy_shims_importable():
    for name in SHIMS:
        mod = importlib.import_module(name)
        assert mod is not None, name


def test_local_pty_shim_platform_gate():
    if sys.platform == "win32":
        try:
            importlib.import_module("openterminal.local_pty")
        except ModuleNotFoundError as e:
            assert "fcntl" in str(e)
        else:
            raise AssertionError("local_pty 在 Windows 上不应可导入")
    else:
        assert importlib.import_module("openterminal.local_pty") is not None


def test_pipeline_core_identity():
    from openterminal.core import PipelineCore
    from openterminal.core.pipeline import PipelineCore as PC
    assert PipelineCore is PC
