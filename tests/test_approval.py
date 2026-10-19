import pytest

from openterminal.frontend.approval import (
    decision_for_choice, edit_decision, reclassify_edited,
)
from openterminal.policy import Policy


def test_approve_and_session_allow():
    allowed: set[str] = set()
    d = decision_for_choice("y", "touch f", Policy(), allowed)
    assert d == {"type": "approve"}
    d = decision_for_choice("a", "touch f", Policy(), allowed)
    assert d == {"type": "approve"}
    assert "touch f" in allowed


def test_reject():
    d = decision_for_choice("n", "rm f", Policy(), set())
    assert d["type"] == "reject" and d["message"]


def test_edit_decision_shape():
    d = edit_decision("touch g")
    assert d == {"type": "edit",
                 "edited_action": {"name": "execute",
                                   "args": {"command": "touch g"}}}


def test_edited_command_reclassified():
    p = Policy()
    assert reclassify_edited("rm -rf /", p).level == "deny"
    assert reclassify_edited("ls", p).level == "auto"
    assert reclassify_edited("touch f", p).level == "approve"


def test_policy_needs_approval_shared_predicate():
    """needs_approval 是 HITL _when 与命令卡预判的唯一来源。"""
    p = Policy()
    assert p.needs_approval("rm -rf /tmp/x") is True
    assert p.needs_approval("ls -la") is False
    # 会话免审集（「始终允许」累积）命中即直通
    allowed = {"rm -rf /tmp/x"}
    assert p.needs_approval("rm -rf /tmp/x", allowed) is False
    assert p.needs_approval("rm -rf /tmp/y", allowed) is True


def test_policy_risk_benign_vs_high():
    p = Policy()
    assert p.risk("rm -rf /tmp/x") == "high"
    # 仅无害理由（approve_extra）→ normal（蓝框）
    p2 = Policy(approve_extra=["touch f"])
    assert p2.risk("touch f") == "normal"


def test_policy_risk_auto_command_not_high():
    """免审命令（auto，reasons 为空）不得判高危——真机 echo 命令卡顶「⚠ 高危」红框。"""
    p = Policy()
    assert p.classify("echo auto-ok").level == "auto"
    assert p.risk("echo auto-ok") == "normal"
    assert p.risk("ls -la") == "normal"


async def test_allow_decision_feeds_session_allowlist():
    """Web「始终允许」(allow:true) 入会话免审集，且 resume 收到干净决策。

    旧实现从不读 allow 字段——按钮等于「执行」（假功能）。
    """
    from openterminal.core.ai_flow import AiFlow
    from openterminal.core.pipeline import PipelineCore

    sent: list = []

    class _Transcript:
        def append(self, *a, **kw):
            pass

    async def ask_approval(command, description, host, risk, id=0):
        return {"type": "approve", "allow": True}

    async def emit_msg(msg):
        sent.append(msg)

    core = object.__new__(PipelineCore)
    core.transcript = _Transcript()
    core.ask_approval = ask_approval
    core.emit_msg = emit_msg
    core._target_host = "h"
    core.allowed = set()
    core.policy = Policy()

    class _Runner:
        def __init__(self):
            self.interrupt_payload = {"action_requests": [
                {"args": {"command": "touch f"}, "description": ""}]}
            self.resumed = None

        def claim_seq(self, name, command):
            return None   # 假任务无工具宣告：审批无关联卡（id=0）

        async def resume(self, decisions):
            self.resumed = decisions
            self.interrupt_payload = None
            return []

    runner = _Runner()
    ai = AiFlow(core)
    await ai._handle_events(runner, [])
    assert "touch f" in core.allowed, "allow:true 必须入会话免审集"
    assert runner.resumed == [{"type": "approve"}], \
        "resume 收到的决策不得残留 allow 键"
    # 免审后同令直通
    assert core.policy.needs_approval("touch f", core.allowed) is False


async def test_tool_claim_index_pairs_same_command_in_order():
    """双同串命令按序消歧：同串并行宣告按进队序认领，认完返 None——
    审批按宣告序配对到工具卡，不许错位/跨队乱配。"""
    from openterminal.agent.runner import _ToolClaimIndex

    q = _ToolClaimIndex()
    q.register("execute", "ls", 1)
    q.register("execute", "ls", 2)
    q.register("execute", "pwd", 3)
    assert q.claim("execute", "ls") == 1
    assert q.claim("execute", "ls") == 2
    assert q.claim("execute", "ls") is None
    assert q.claim("execute", "pwd") == 3
    assert q.claim("read_file", "") is None


async def test_runner_claims_registered_with_full_command():
    """tool_start 宣告即入认领表，command 完整不截（截 120 字符会让长命令断链；
    ActionRequest 不带 tool_call id，认领表是审批对回工具卡的唯一纽带）。"""
    from langchain_core.messages import AIMessage
    from openterminal.agent.runner import TaskRunner

    long = "echo " + "x" * 200
    runner = TaskRunner(None, "th-claims")
    events: list = []
    await runner._absorb(AIMessage(content="", tool_calls=[
        {"name": "execute", "args": {"command": "ls"},
         "id": "a1", "type": "tool_call"},
        {"name": "execute", "args": {"command": "ls"},
         "id": "a2", "type": "tool_call"},
        {"name": "execute", "args": {"command": long},
         "id": "a3", "type": "tool_call"},
    ]), "agent", events)
    starts = [e for e in events if e.kind == "tool_start"]
    assert starts[2].command == long        # 红行：完整 command（不截）
    assert starts[2].text == long[:120]     # 展示摘要仍截 120
    assert runner.claim_seq("execute", "ls") == 1
    assert runner.claim_seq("execute", "ls") == 2
    assert runner.claim_seq("execute", "ls") is None
    assert runner.claim_seq("execute", long) == 3
