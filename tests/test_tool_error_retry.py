"""工具异常→回模型重试、用尽后「任务失败」的回归（docs/bug.md 上传场景）。

无 PTY 依赖，Windows/POSIX 都能跑。两层防护各钉一组：
1. ToolErrorRetryMiddleware：异常不打死任务，3 次内交模型重试，之后宣告任务失败；
2. PtyShellBackend：路径 ValueError（/C:/... 过 validate_path 却在 _resolve_path
   越界）包成 error 结果，不外抛。
"""

from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.errors import GraphBubbleUp

from openterminal.agent.backend import PtyShellBackend
from openterminal.agent.middleware import ToolErrorRetryMiddleware
from openterminal.agent.runner import TaskRunner
from tests.fakes import FakeModel, scripted, tool_call


# --- ToolErrorRetryMiddleware 单元 ---

def _req(tool_name: str = "read_file", call_id: str = "t1"):
    return SimpleNamespace(
        tool_call={"name": tool_name, "args": {"file_path": "/x"}, "id": call_id})


async def test_exception_becomes_tool_error_and_invites_retry():
    mw = ToolErrorRetryMiddleware(max_retries=3)

    async def boom(request):
        raise ValueError("Path outside root")

    msg = await mw.awrap_tool_call(_req(), boom)
    assert isinstance(msg, ToolMessage)
    assert msg.status == "error"
    assert "ValueError" in msg.content and "outside root" in msg.content
    assert "重试" in msg.content
    assert "任务失败" not in msg.content
    assert mw._failures == 1 and not mw._gave_up


async def test_third_failure_still_allows_retry_fourth_says_task_failed():
    mw = ToolErrorRetryMiddleware(max_retries=3)

    async def boom(request):
        raise RuntimeError("boom")

    for i in range(1, 4):
        msg = await mw.awrap_tool_call(_req(), boom)
        assert "任务失败" not in msg.content, f"第 {i} 次失败不应宣告任务失败"
        assert mw._failures == i
    msg = await mw.awrap_tool_call(_req(), boom)
    assert "任务失败" in msg.content
    assert "总结失败原因" in msg.content
    assert mw._gave_up


async def test_after_gave_up_tool_calls_rejected_without_execution():
    mw = ToolErrorRetryMiddleware(max_retries=1)

    async def boom(request):
        raise ValueError("x")

    await mw.awrap_tool_call(_req(), boom)   # 失败 1：允许重试
    await mw.awrap_tool_call(_req(), boom)   # 失败 2：任务失败
    ran = []

    async def ok(request):
        ran.append(1)
        return ToolMessage(content="ok", tool_call_id="t1", name="read_file")

    msg = await mw.awrap_tool_call(_req(), ok)
    assert ran == []                          # 未真正执行
    assert "任务失败" in msg.content and msg.status == "error"


async def test_graph_bubble_up_propagates():
    mw = ToolErrorRetryMiddleware()

    async def interrupt(request):
        raise GraphBubbleUp()

    with pytest.raises(GraphBubbleUp):
        await mw.awrap_tool_call(_req(), interrupt)
    assert mw._failures == 0                   # 控制流不计入失败


async def test_counter_resets_per_task():
    mw = ToolErrorRetryMiddleware(max_retries=3)

    async def boom(request):
        raise ValueError("x")

    await mw.awrap_tool_call(_req(), boom)
    await mw.awrap_tool_call(_req(), boom)
    assert mw._failures == 2
    mw.before_agent({}, None)
    assert mw._failures == 0 and not mw._gave_up


async def test_sync_wrap_tool_call_also_catches():
    mw = ToolErrorRetryMiddleware(max_retries=3)

    def boom(request):
        raise ValueError("sync boom")

    msg = mw.wrap_tool_call(_req(), boom)
    assert isinstance(msg, ToolMessage) and "sync boom" in msg.content


# --- PtyShellBackend：路径 ValueError 不外抛 ---

class _Sess:
    cwd = "/tmp"


def test_read_outside_root_returns_error_result():
    b = PtyShellBackend(_Sess(), root_dir=None)
    # /C:/... 过 validate_path、_resolve_path 判越界——曾直接 ValueError 打死任务
    r = b.read("/C:/Users/Administrator/Desktop/1.txt")
    assert r.error is not None
    assert "outside root" in r.error
    assert r.file_data is None


def test_write_outside_root_returns_error_result():
    b = PtyShellBackend(_Sess(), root_dir=None)
    r = b.write("/C:/Users/Administrator/Desktop/1.txt", "hi")
    assert r.error and r.path is None


def test_ls_outside_root_returns_error_result():
    b = PtyShellBackend(_Sess(), root_dir=None)
    r = b.ls("/C:/Users/Administrator/Desktop")
    assert r.error and r.entries is None


# --- 整链路：TaskRunner 不再被工具异常打死 ---

async def test_task_runner_survives_tool_exception_and_model_summarizes():
    from deepagents import create_deep_agent
    from deepagents.backends import LocalShellBackend
    from langgraph.checkpoint.memory import MemorySaver

    model = scripted(
        tool_call("read_file", {"file_path": "/boom"}, "b1"),
        tool_call("read_file", {"file_path": "/boom"}, "b2"),
        tool_call("read_file", {"file_path": "/boom"}, "b3"),
        tool_call("read_file", {"file_path": "/boom"}, "b4"),
        AIMessage(content="任务失败：路径越界，已尝试读取桌面文件未成功。"),
    )
    backend = LocalShellBackend(root_dir=None, inherit_env=True)
    # 打桩 read：恒抛 ValueError——模拟「过了 validate_path 却在解析越界」
    def _raise(path, offset=0, limit=2000):
        raise ValueError(f"Path:{path} outside root directory")
    backend.read = _raise
    agent = create_deep_agent(
        model=model, backend=backend, system_prompt="t",
        middleware=[ToolErrorRetryMiddleware(max_retries=3)],
        checkpointer=MemorySaver(),
    )
    runner = TaskRunner(agent, "th-err-retry", max_tool_turns=10)
    events = await runner.run("帮我把电脑桌面的1.txt上传到/tmp目录下")
    kinds = [e.kind for e in events]
    assert "final" in kinds                     # 任务未被异常打死
    final = next(e for e in events if e.kind == "final")
    assert "任务失败" in final.text             # 模型总结了失败原因
    assert not any(e.kind == "error" for e in events)


# --- ModelRetryMiddleware：模型 API 侧重试（build_agent 装配 + 行为） ---

class FlakyModel(FakeModel):
    """前 fail_times 次调用抛错，之后放行——模拟网关抖动。"""

    fail_times: int = 0
    calls: int = 0

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("gateway down")
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def _model_retry(max_retries: int = 3):
    from langchain.agents.middleware import ModelRetryMiddleware

    def on_failure(exc: Exception) -> str:
        return (f"任务失败：模型调用重试 {max_retries} 次仍未成功"
                f"（{type(exc).__name__}: {exc}）。请稍后重试。")

    return ModelRetryMiddleware(
        max_retries=max_retries, on_failure=on_failure,
        backoff_factor=0.0, initial_delay=0.0,   # 测试不睡退避
    )


async def test_model_retry_recovers_after_transient_failures():
    from deepagents import create_deep_agent
    from deepagents.backends import LocalShellBackend
    from langgraph.checkpoint.memory import MemorySaver

    model = FlakyModel(messages=iter([AIMessage(content="网关恢复，任务完成。")]),
                       fail_times=2)
    agent = create_deep_agent(
        model=model, backend=LocalShellBackend(root_dir=None, inherit_env=True),
        system_prompt="t", middleware=[_model_retry()],
        checkpointer=MemorySaver(),
    )
    runner = TaskRunner(agent, "th-model-retry-ok", max_tool_turns=10)
    events = await runner.run("x")
    final = next(e for e in events if e.kind == "final")
    assert "任务完成" in final.text
    assert model.calls == 3                     # 2 次失败 + 1 次成功


async def test_model_retry_exhausted_returns_task_failed():
    from deepagents import create_deep_agent
    from deepagents.backends import LocalShellBackend
    from langgraph.checkpoint.memory import MemorySaver

    model = FlakyModel(messages=iter([AIMessage(content="unused")]),
                       fail_times=99)
    agent = create_deep_agent(
        model=model, backend=LocalShellBackend(root_dir=None, inherit_env=True),
        system_prompt="t", middleware=[_model_retry(max_retries=3)],
        checkpointer=MemorySaver(),
    )
    runner = TaskRunner(agent, "th-model-retry-dead", max_tool_turns=10)
    events = await runner.run("x")
    final = next(e for e in events if e.kind == "final")
    assert "任务失败" in final.text and "gateway down" in final.text
    assert model.calls == 4                     # 1 初次 + 3 重试
    assert not any(e.kind == "error" for e in events)


def test_build_agent_wires_model_retry(monkeypatch):
    from langchain.agents.middleware import ModelRetryMiddleware

    from openterminal.agent import build as B
    from openterminal.agent.sysprobe import SystemProfile
    from openterminal.config import Config

    captured: dict = {}
    real = B.create_deep_agent

    def spy(**kwargs):
        captured.update(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(B, "create_deep_agent", spy)
    profile = SystemProfile(
        host="local", os_family="debian", distro="Ubuntu", version="22.04",
        kernel="5.15", pkg_manager="apt", service_mgr="systemd",
        shell="/bin/bash", tools={},
    )

    class S:
        cwd = "/tmp"

    B.build_agent(profile, S(), Config.load())
    mws = captured["middleware"]
    names = [type(m).__name__ for m in mws]
    assert "ToolErrorRetryMiddleware" in names
    assert "ModelRetryMiddleware" in names
    mr = next(m for m in mws if isinstance(m, ModelRetryMiddleware))
    assert mr.max_retries == 3
    tr = next(m for m in mws if type(m).__name__ == "ToolErrorRetryMiddleware")
    assert tr.max_retries == 3
