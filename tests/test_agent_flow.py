import sys

import pytest

# 模块级跳过须在 import local_pty 之前：Windows 上 fcntl 不存在，
# 顶层导入会直接 ImportError，pytestmark 的 skipif 来不及生效
if sys.platform == "win32":
    pytest.skip("PTY 仅 POSIX", allow_module_level=True)

from langchain_core.messages import AIMessage
from langgraph.errors import GraphRecursionError

from openterminal.agent import (
    DenyMiddleware, TaskRunner, build_agent, build_system_prompt,
)
from openterminal.config import Config
from openterminal.local_pty import LocalPtySession
from openterminal.policy import Policy
from openterminal.sysprobe import MANUAL_PRESETS, SystemProfile
from tests.fakes import scripted, tool_call


@pytest.fixture(autouse=True)
def _run_inside_tmp(tmp_path, monkeypatch):
    # 偏离计划（仅测试侧、最小）：用例会启动真实 PTY 并真实执行
    # `touch new.txt`（approve 分支）。pty.fork 出的 shell 继承父进程 cwd，
    # 因此在 session.start() 前 chdir 到 tmp 目录，避免在仓库里留下文件。
    monkeypatch.chdir(tmp_path)


def profile():
    return SystemProfile(
        host="local", os_family="debian", distro="Ubuntu", version="22.04",
        kernel="5.15", pkg_manager="apt", service_mgr="systemd",
        shell="/bin/bash", tools={},
    )


async def _agent(model, policy=None):
    session = LocalPtySession()
    await session.start()
    cfg = Config.load()
    graph, allowed, backend = build_agent(profile(), session, cfg,
                                          policy or Policy(), model=model)
    return graph, session, allowed, backend


async def test_success_flow():
    model = scripted(
        tool_call("execute", {"command": "echo hello"}, "t1"),
        AIMessage(content="任务完成，已输出 hello。"),
    )
    graph, session, _, _ = await _agent(model)
    runner = TaskRunner(graph, "th-1", max_tool_turns=10)
    events = await runner.run("打个招呼")
    kinds = [e.kind for e in events]
    assert "tool_call" in kinds and "final" in kinds
    assert any("hello" in e.text for e in events if e.kind == "final")
    await session.close()


async def test_deny_blocks_and_model_pivots():
    model = scripted(
        tool_call("execute", {"command": "rm -rf /"}, "t1"),
        tool_call("execute", {"command": "echo safe"}, "t2"),
        AIMessage(content="已改用安全命令。"),
    )
    graph, session, _, _ = await _agent(model)
    runner = TaskRunner(graph, "th-2", max_tool_turns=10)
    events = await runner.run("x")
    assert "denied" in [e.kind for e in events]
    assert any(e.kind == "final" for e in events)
    await session.close()


async def test_interrupt_and_approve():
    model = scripted(
        tool_call("execute", {"command": "touch new.txt"}, "t1"),
        AIMessage(content="已创建文件。"),
    )
    graph, session, _, _ = await _agent(model)
    runner = TaskRunner(graph, "th-3", max_tool_turns=10)
    events = await runner.run("x")
    assert runner.interrupt_payload is not None
    assert any(e.kind == "interrupt" for e in events)
    events2 = await runner.resume([{"type": "approve"}])
    assert any(e.kind == "final" for e in events2)
    await session.close()


async def test_interrupt_reject_then_model_changes_plan():
    model = scripted(
        tool_call("execute", {"command": "touch new.txt"}, "t1"),
        AIMessage(content="好的，不执行写操作。"),
    )
    graph, session, _, _ = await _agent(model)
    runner = TaskRunner(graph, "th-4", max_tool_turns=10)
    await runner.run("x")
    events = await runner.resume([{"type": "reject", "message": "不要写文件"}])
    assert any(e.kind == "final" for e in events)
    await session.close()


async def test_parallel_tool_caps_require_parallel_decisions():
    # 回归：模型一轮并行发起两个 approve 命令时，HITL 中断带两个 action
    # request，resume 必须给两个决定（少给会抛 ValueError 打挂调用方）
    model = scripted(
        AIMessage(content="", tool_calls=[
            {"name": "execute", "args": {"command": "touch aa.txt"},
             "id": "p1", "type": "tool_call"},
            {"name": "execute", "args": {"command": "touch bb.txt"},
             "id": "p2", "type": "tool_call"},
        ]),
        AIMessage(content="两个文件都建好了。"),
    )
    graph, session, _, _ = await _agent(model)
    runner = TaskRunner(graph, "th-parallel", max_tool_turns=10)
    await runner.run("x")
    assert len(runner.interrupt_payload["action_requests"]) == 2
    events = await runner.resume([
        {"type": "approve"}, {"type": "approve"},
    ])
    assert any(e.kind == "final" for e in events)
    from pathlib import Path

    assert Path("aa.txt").exists() and Path("bb.txt").exists()
    await session.close()


async def test_recursion_budget_reports_limit():
    # 模型一直调工具，必须在预算处停下并产出 limit 事件
    model = scripted(*[tool_call("execute", {"command": "echo x"}, f"t{i}")
                       for i in range(30)])
    graph, session, _, _ = await _agent(model)
    runner = TaskRunner(graph, "th-5", max_tool_turns=4)
    events = await runner.run("loop")
    assert "limit" in [e.kind for e in events]
    await session.close()


def test_system_prompt_contains_dialect():
    p = build_system_prompt(profile())
    assert "apt" in p and "ubuntu" in p.lower() or "debian" in p


def test_message_text_extracts_text_blocks_only():
    from langchain_core.messages import AIMessageChunk

    from openterminal.agent import message_text

    m = AIMessage(content=[
        {"type": "thinking", "thinking": "内部推理，不应展示"},
        {"type": "text", "text": "给用户的回答"},
    ])
    assert message_text(m) == "给用户的回答"
    plain = AIMessage(content="普通字符串")
    assert message_text(plain) == "普通字符串"
    chunk = AIMessageChunk(content=[{"type": "text", "text": "abc"}])
    assert message_text(chunk) == "abc"


async def test_streaming_thinking_reaches_live_events_not_final():
    # 网关模型的思考块（{'type': 'thinking'}）要以 think 事件实时外送
    # （前端分析卡展示中间过程），且不混进 final 总结文本
    m = AIMessage(content=[
        {"type": "thinking", "thinking": "内部推理过程"},
        {"type": "text", "text": "给用户的回答"},
    ])
    graph, session, _, _ = await _agent(scripted(m))
    seen: list = []
    runner = TaskRunner(graph, "th-think", max_tool_turns=10,
                        on_event=seen.append)
    events = await runner.run("x")
    assert any(e.kind == "think" and e.text == "内部推理过程" for e in seen)
    assert any(e.kind == "token" and e.text == "给用户的回答" for e in seen)
    final = next(e for e in events if e.kind == "final")
    assert final.text == "给用户的回答"   # 思考块不进总结
    await session.close()


async def test_on_event_delivers_live_token_not_final():
    seen: list = []
    model = scripted(
        tool_call("execute", {"command": "echo hi"}, "e1"),
        AIMessage(content="任务完成。"),
    )
    graph, session, _, _ = await _agent(model)
    runner = TaskRunner(graph, "th-live", max_tool_turns=10,
                        on_event=seen.append)
    events = await runner.run("x")
    live_kinds = [e.kind for e in seen]
    assert "token" in live_kinds
    assert "final" not in live_kinds          # 收尾事件不走实时回调
    assert any(e.kind == "final" for e in events)  # 返回列表里仍有
    await session.close()


async def test_failed_command_exit_code_via_backend_callback():
    # ls 不存在路径：静态分级 auto（无需审批），真实退出码非 0
    model = scripted(
        tool_call("execute", {"command": "ls /no/such/path_xyz"}, "f1"),
        AIMessage(content="目录不存在。"),
    )
    graph, session, _, backend = await _agent(model)
    finishes: list[tuple[str, int]] = []
    backend.on_finish = lambda cmd, code: finishes.append((cmd, code))
    runner = TaskRunner(graph, "th-failcode", max_tool_turns=10)
    await runner.run("x")
    assert len(finishes) == 1
    cmd, code = finishes[0]
    assert cmd == "ls /no/such/path_xyz" and code != 0
    await session.close()


async def test_approved_command_shows_execute_panel_and_result(
        capsys, monkeypatch):
    # 审批通过后界面应显示“执行”面板与真实输出（审批面板已擦除，不重复）
    import openterminal.cli as cli_mod
    from openterminal.cli import Cli
    from openterminal.config import Config

    async def yes():
        return "y"

    monkeypatch.setattr(cli_mod, "_prompt_choice", yes)

    model = scripted(
        tool_call("execute", {"command": "touch panel_test.txt"}, "t1"),
        AIMessage(content="已创建文件。"),
    )
    graph, session, _, backend = await _agent(model)
    c = Cli(Config.load())
    c.agent, c.backend, c.session = graph, backend, session
    c.profile = profile()
    await c.run_task("建文件")

    out = capsys.readouterr().out
    assert "将执行" in out   # 审批面板出现过
    assert "执行" in out     # 决策后执行面板出现
    from pathlib import Path

    assert Path("panel_test.txt").exists()
    await session.close()
