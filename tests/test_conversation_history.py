import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

from openterminal.config import TargetConfig
from openterminal.core.conversation_history import (
    ConversationHistory, connection_key, restore_completed,
)


def _target(**kwargs):
    return TargetConfig(name=kwargs.pop("name", "prod"), mode="ssh",
                        host=kwargs.pop("host", "example.test"),
                        port=kwargs.pop("port", 22),
                        user=kwargs.pop("user", "root"), **kwargs)


def test_connection_key_survives_rename_but_isolates_address():
    target = _target()
    assert connection_key("old-name", target) == connection_key("new-name", target)
    assert connection_key("old-name", target) != connection_key(
        "old-name", _target(host="other.test"))
    assert connection_key("local", TargetConfig(mode="local", name="local")) == (
        connection_key("default", TargetConfig(mode="local", name="default")))


def test_history_roundtrips_replay_snapshot_and_manual_context(tmp_path):
    history = ConversationHistory(tmp_path / "history.db")
    key = connection_key("prod", _target())
    conversation_id = history.start(
        target_key=key, target_name="prod", title="inspect image")
    image = "data:image/png;base64,iVBORw0KGgo="
    values = {"messages": [
        HumanMessage(content=[
            {"type": "text", "text": "inspect"},
            {"type": "image_url", "image_url": {"url": image}},
        ]),
        AIMessage(content="", tool_calls=[{
            "name": "execute", "args": {"command": "echo once"},
            "id": "tool-1", "type": "tool_call",
        }]),
        ToolMessage(content="once", tool_call_id="tool-1", name="execute"),
        AIMessage(content="done"),
    ], "todos": [{"content": "inspect", "status": "completed"}]}
    manual = ["【你在任务外，用户手动执行了】\n- `pwd`"]
    history.save_complete(
        conversation_id, values, manual, model="test-model")
    frames = [
        {"kind": "json", "data": {
            "type": "event", "event": {"kind": "task_start", "text": "inspect"}}},
        {"kind": "bytes", "data": "b25jZQ=="},
        {"kind": "json", "data": {
            "type": "event", "event": {"kind": "task_end"}}},
    ]
    history.save_ui_frames(conversation_id, frames)

    listed = history.list(key)
    assert listed[0]["status"] == "completed"
    assert listed[0]["continuable"] is True
    item = history.get(conversation_id)
    assert [m["role"] for m in item["messages"]] == [
        "user", "assistant", "tool", "assistant"]
    assert item["messages"][0]["content"][1] == {
        "type": "image", "url": image}
    assert item["messages"][1]["tool_calls"][0]["args"]["command"] == "echo once"
    assert item["ui_frames"] == frames
    restored, restored_manual = history.load_snapshot(conversation_id)
    assert restored["todos"] == values["todos"]
    assert restored["messages"][-1].content == "done"
    assert restored_manual == manual


def test_interrupted_without_completed_snapshot_is_not_continuable(tmp_path):
    history = ConversationHistory(tmp_path / "history.db")
    key = connection_key("prod", _target())
    conversation_id = history.start(
        target_key=key, target_name="prod", title="waiting for approval")
    assert history.get(conversation_id)["status"] == "interrupted"
    assert history.get(conversation_id)["continuable"] is False
    with pytest.raises(ValueError, match="完成态"):
        history.load_snapshot(conversation_id)


def test_delete_removes_only_requested_history(tmp_path):
    history = ConversationHistory(tmp_path / "history.db")
    key = connection_key("prod", _target())
    first = history.start(
        target_key=key, target_name="prod", title="first")
    second = history.start(
        target_key=key, target_name="prod", title="second")
    assert history.delete(first)
    assert history.get(first) is None
    assert history.get(second) is not None


def test_mark_interrupted_rejects_missing_record(tmp_path):
    history = ConversationHistory(tmp_path / "history.db")
    with pytest.raises(LookupError, match="unknown conversation"):
        history.mark_interrupted("missing")


@pytest.mark.asyncio
async def test_resumed_worker_updates_original_history_and_can_resume_again(
        tmp_path, monkeypatch):
    from openterminal.agent.build import build_agent
    from openterminal.agent.runner import TaskRunner
    from openterminal.agent.sysprobe import LOCAL_PROFILE
    from openterminal.config import Config
    from openterminal.web.worker import TabWorker
    from tests.fakes import scripted
    from tests.web_fakes import FakeSession

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    cfg = Config()
    target = cfg.targets["default"]
    history = ConversationHistory()
    key = connection_key("local", target)
    original = build_agent(
        LOCAL_PROFILE, FakeSession(), cfg,
        model=scripted(AIMessage(content="original answer")))[0]
    original_runner = TaskRunner(original, "original")
    await original_runner.run("original question")
    snapshot = await original.aget_state(original_runner.cfg)
    history_id = history.start(
        target_key=key, target_name="local", title="original question")
    history.save_complete(history_id, snapshot.values, [])
    original_frames = [{"kind": "json", "data": {
        "type": "event", "event": {"kind": "task_start", "text": "original question"}}}]
    history.save_ui_frames(history_id, original_frames)

    async def make_worker(*responses):
        worker = TabWorker(cfg, "local")
        worker.enable_history(target, resume_id=history_id)
        worker._history_ui_frames = list(history.get(history_id)["ui_frames"])
        worker.session = FakeSession()
        worker.profile = LOCAL_PROFILE
        worker.agent, worker.allowed, worker.backend = build_agent(
            LOCAL_PROFILE, worker.session, cfg,
            model=scripted(*(AIMessage(content=r) for r in responses)))
        await worker.ai._restore_agent_context()
        return worker

    worker = await make_worker("second answer", "third answer")
    await worker.ai._run_task("second question", hooked=True)
    await worker.ai._run_task("third question", hooked=True)
    assert worker._history_conversation_id == history_id
    assert [item["id"] for item in history.list(key)] == [history_id]
    item = history.get(history_id)
    assert item["title"] == "original question"
    assert item["status"] == "completed"
    assert [message["content"] for message in item["messages"]] == [
        "original question", "original answer", "second question",
        "second answer", "third question", "third answer"]
    assert item["ui_frames"][:len(original_frames)] == original_frames
    assert any(frame.get("data", {}).get("event", {}).get("text") == "third question"
               for frame in item["ui_frames"] if frame["kind"] == "json")
    await worker.close()

    resumed = await make_worker("fourth answer")
    await resumed.ai._run_task("fourth question", hooked=True)
    assert [item["id"] for item in history.list(key)] == [history_id]
    assert history.get(history_id)["messages"][-1]["content"] == "fourth answer"
    resumed._reset_context()
    await resumed.close()


@pytest.mark.asyncio
async def test_resumed_worker_without_new_task_does_not_change_history(
        tmp_path, monkeypatch):
    from openterminal.config import Config
    from openterminal.web.worker import TabWorker

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    cfg = Config()
    target = cfg.targets["default"]
    history = ConversationHistory()
    history_id = history.start(
        target_key=connection_key("local", target),
        target_name="local", title="original")
    history.save_complete(history_id, {"messages": [HumanMessage(content="original")]}, [])
    frames = [{"kind": "bytes", "data": "b3JpZ2luYWw="}]
    history.save_ui_frames(history_id, frames)
    before = history.get(history_id)
    worker = TabWorker(cfg, "local")
    worker.enable_history(target, resume_id=history_id)
    worker._history_ui_frames = list(frames)
    await worker.emit_bytes(b"new connection output")
    await worker.close()
    assert history.get(history_id) == before


@pytest.mark.asyncio
async def test_restored_complete_agent_does_not_replay_tool(tmp_path, monkeypatch):
    from openterminal.agent.build import build_agent
    from openterminal.agent.runner import TaskRunner
    from openterminal.agent.sysprobe import LOCAL_PROFILE
    from openterminal.config import Config
    from tests.fakes import scripted, tool_call

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    calls = []

    @tool
    def record_once(value: str) -> str:
        """Record a value for the history test."""
        calls.append(value)
        return value

    class Session:
        cwd = "/tmp"

    original = build_agent(
        LOCAL_PROFILE, Session(), Config(),
        model=scripted(
            tool_call("record_once", {"value": "executed"}, "once-1"),
            AIMessage(content="original complete")),
        tools=[record_once])[0]
    runner = TaskRunner(original, "original")
    await runner.run("run it")
    assert calls == ["executed"]
    snapshot = await original.aget_state(runner.cfg)
    assert snapshot.next == ()

    history = ConversationHistory(tmp_path / "history.db")
    history_id = history.start(
        target_key="key", target_name="local", title="tool task")
    history.save_complete(history_id, snapshot.values, [])
    values, manual = history.load_snapshot(history_id)
    assert manual == []

    rebuilt = build_agent(
        LOCAL_PROFILE, Session(), Config(),
        model=scripted(AIMessage(content="continued safely")),
        tools=[record_once])[0]
    restored_runner = TaskRunner(rebuilt, "restored")
    await restore_completed(rebuilt, restored_runner.cfg, values)
    assert (await rebuilt.aget_state(restored_runner.cfg)).next == ()
    assert any(
        event.kind == "final"
        for event in await restored_runner.run("continue"))
    assert calls == ["executed"], "historical tools must never be replayed"
