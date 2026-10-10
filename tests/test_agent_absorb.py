"""_absorb 幂等单测：HITL after_model 回灌的同一条 AIMessage 不得重复宣告工具卡。

docs/card_duplicate.md P0-1 验收落点。无 PTY 依赖，Windows/POSIX 都能跑；
直打风格照 tests/test_agent_flow.py 的 TaskRunner(object()) 模式。
"""

from langchain_core.messages import AIMessage, ToolMessage

from openterminal.agent import TaskRunner


def _ai_two_calls() -> AIMessage:
    # HITL after_model 回灌时 id 不变、tool_calls 原地修订——与线上同形
    return AIMessage(content="", id="ai-1", tool_calls=[
        {"name": "execute", "args": {"command": "kubectl get nodes"},
         "id": "tc1", "type": "tool_call"},
        {"name": "execute", "args": {"command": "hostname -I"},
         "id": "tc2", "type": "tool_call"},
    ])


async def test_absorb_idempotent_for_replayed_ai_message():
    # 同一条 AIMessage 连续吸收两次（model 宣告 + after_model 回灌）：
    # tool_start/tool_call 各 2 条、序号不重复、配对保持首次宣告的 index
    seen: list = []
    runner = TaskRunner(object(), "th-absorb-1", on_event=seen.append)
    events: list = []
    ai = _ai_two_calls()
    await runner._absorb(ai, "model", events)
    first = {tid: idx for tid, idx in runner._pending_tools.items()}
    await runner._absorb(ai, "after_model", events)   # resume 后回灌重放

    starts = [e for e in seen if e.kind == "tool_start"]
    calls = [e for e in seen if e.kind == "tool_call"]
    assert len(starts) == 2
    assert len({e.index for e in starts}) == 2        # 序号各不重复
    assert len(calls) == 2                            # 记账不双计
    assert runner._tool_calls == 2
    assert runner._pending_tools == first             # 仍指向首次宣告的 index
    assert set(runner._tool_seen) == {"tc1", "tc2"}   # 宣告去重集只增不减


async def test_tool_end_pairs_to_first_announced_index():
    # tool_end 徽标必须换回原卡：配对首次宣告的 index，而非回灌重放的
    seen: list = []
    runner = TaskRunner(object(), "th-absorb-2", on_event=seen.append)
    events: list = []
    ai = _ai_two_calls()
    await runner._absorb(ai, "model", events)
    first_index = runner._pending_tools["tc1"][0]
    await runner._absorb(ai, "after_model", events)   # 重放
    await runner._absorb(
        ToolMessage(content="ok", tool_call_id="tc1"), "tools", events)

    ends = [e for e in seen if e.kind == "tool_end"]
    assert len(ends) == 1                             # ToolMessage 分支本就幂等
    assert ends[0].index == first_index
    assert ends[0].name == "execute"
    assert not ends[0].failed
    # 收尾后同一 AIMessage 若再被回灌（异常重放），也不得复活宣告：
    # seen 集是「全任务只宣告一次」的语义，不依赖 _pending_tools 的 key 存在
    await runner._absorb(ai, "after_model", events)
    assert len([e for e in seen if e.kind == "tool_start"]) == 2


async def test_tool_call_without_id_still_announced():
    # 缺 id 防御：langchain 构造期强制 tool_call 有 id（TypeError），
    # 空串 id 是可达的空 id 路径——不去重、按原行为宣告，不得静默丢卡
    seen: list = []
    runner = TaskRunner(object(), "th-absorb-3", on_event=seen.append)
    events: list = []
    ai = AIMessage(content="", tool_calls=[
        {"name": "read_file", "args": {"path": "x"}, "id": "",
         "type": "tool_call"}])
    await runner._absorb(ai, "model", events)
    starts = [e for e in seen if e.kind == "tool_start"]
    assert len(starts) == 1
    assert starts[0].name == "read_file"


async def test_tool_end_error_pairs_first_announced_index():
    # reject 路径：status=error → tool_end.failed=True（✗ 徽标），同样换回原卡
    seen: list = []
    runner = TaskRunner(object(), "th-absorb-4", on_event=seen.append)
    events: list = []
    ai = AIMessage(content="", id="ai-2", tool_calls=[
        {"name": "execute", "args": {"command": "rm -rf /tmp/x"},
         "id": "e1", "type": "tool_call"}])
    await runner._absorb(ai, "model", events)
    first_index = runner._pending_tools["e1"][0]
    await runner._absorb(ai, "after_model", events)   # 重放
    await runner._absorb(
        ToolMessage(content="User rejected the tool call", tool_call_id="e1",
                    status="error"),
        "after_model", events)
    ends = [e for e in seen if e.kind == "tool_end"]
    assert len(ends) == 1
    assert ends[0].failed is True
    assert ends[0].index == first_index
