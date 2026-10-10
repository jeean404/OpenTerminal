"""阶段一验收硬线回归：worker 命名空间桥 + emit 抽象。"""
import asyncio
import json

import pytest

import openterminal.web.worker as wmod
from openterminal.config import Config
from openterminal.core import PipelineCore, ServerMsg


def test_patch_bridge_forwards_to_core(monkeypatch):
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 42)
    import openterminal.core as cmod
    assert cmod.SUBMIT_FALLBACK_DELAY == 42
    monkeypatch.undo()
    assert cmod.SUBMIT_FALLBACK_DELAY == 1.2


def test_servermsg_reexport_identity():
    from openterminal.web.protocol import ServerMsg as ProtoServerMsg
    assert ProtoServerMsg is ServerMsg


def test_base_emit_abstract():
    core = PipelineCore(Config.load(), "default")
    with pytest.raises(NotImplementedError):
        asyncio.run(core.emit_msg(ServerMsg(type="status", text="x")))
    with pytest.raises(NotImplementedError):
        core._emit_nowait(ServerMsg(type="status", text="x"))


def test_clientmsg_upmoved_and_reexported():
    from openterminal.web.protocol import ClientMsg as ProtoClientMsg
    from openterminal.core import ClientMsg
    assert ProtoClientMsg is ClientMsg


def test_feed_input_wraps_raw_and_routes_via_feed_msg():
    """feed_input 必须等价 ClientMsg(type="raw") 且经 feed_msg（_inbox 顺序语义）。"""
    core = PipelineCore(Config.load(), "default")
    sent = []

    async def _capture(msg):
        sent.append(msg)

    core.feed_msg = _capture
    asyncio.run(core.feed_input(b"ls -al\r"))
    assert len(sent) == 1
    assert sent[0].type == "raw"
    assert sent[0].data == b"ls -al\r"


def test_patch_bridge_skips_dunders():
    import openterminal.core as cmod
    old_core_doc = cmod.__doc__
    old_wmod_doc = wmod.__doc__
    wmod.__doc__ = "bridge-leak-probe"
    try:
        assert cmod.__doc__ == old_core_doc   # dunder 不转发
    finally:
        wmod.__doc__ = old_wmod_doc


def test_ask_approval_tracks_pending_and_clears_on_decision():
    """未决审批记账：等待期间 _pending_approval 在位，决策落地即清。"""
    core = PipelineCore(Config.load(), "default")
    emitted = []

    async def _emit(msg):
        emitted.append(msg)

    core.emit_msg = _emit

    async def _main():
        task = asyncio.create_task(core.ask_approval(
            "rm -rf /tmp/ot_pending", "高危命令需要审批", "h", "high"))
        await asyncio.sleep(0.05)
        assert core._pending_approval is not None
        assert core._pending_approval.command == "rm -rf /tmp/ot_pending"
        await core._decisions.put({"type": "approve"})
        val = await task
        assert val == {"type": "approve"}
        assert core._pending_approval is None

    asyncio.run(_main())
    assert emitted[0].type == "approval"


def test_ask_approval_pending_cleared_on_close_sentinel():
    """close() 的 None 哨兵解阻塞后 pending 也必须清（否则重挂误补发）。"""
    core = PipelineCore(Config.load(), "default")

    async def _emit(msg):
        return None

    core.emit_msg = _emit

    async def _main():
        task = asyncio.create_task(
            core.ask_approval("rm -rf /tmp/ot_pending2", "r", "h"))
        await asyncio.sleep(0.05)
        assert core._pending_approval is not None
        await core._decisions.put(None)
        with pytest.raises(ConnectionError):
            await task
        assert core._pending_approval is None

    asyncio.run(_main())


# --- P2-5：ad-hoc 目标（非 saved）的密码记忆 ---


def _adhoc_core(name="x@1.2.3.4", host="1.2.3.4", user="x"):
    from openterminal.config import TargetConfig

    cfg = Config.load()
    cfg.targets[name] = TargetConfig(name=name, mode="ssh", host=host, user=user)
    return PipelineCore(cfg, name)


def test_password_remember_stores_adhoc_display_name_key(monkeypatch):
    """P2-5：ad-hoc 临时目标（_resolve_target_name 重建形态）登录成功后，
    前端 ready 后「记住」确认（password_remember）→ 密码按临时目标
    display_name 三元组写 keyring；未确认不写——「未记住的连接不替用户
    做主」（backfill 门槛同语义，见 test_connections 的补存用例）。询问
    的发出方是前端 ready 后确认框（tests/js/pw_capture.test.cjs 钉）。
    """
    import openterminal.core as cmod
    from openterminal.core import ClientMsg

    core = _adhoc_core()
    stored: list = []
    monkeypatch.setattr(
        cmod, "store_password",
        lambda h, u, p, pw: stored.append((h, u, p, pw)) or True)

    async def _emit(msg):
        return None
    core.emit_msg = _emit

    async def _main():
        # 内联提交只留档（remember=False）：未确认前不自动写
        await core.feed_msg(ClientMsg(type="auth", auth_kind="password",
                                      text="pw", remember=False))
        assert stored == []
        # 确认「记住」→ 键 = pe@host 形态的 display_name 三元组
        await core.feed_msg(ClientMsg(type="auth",
                                      auth_kind="password_remember"))
        assert stored == [("1.2.3.4", "x", None, "pw")]

    asyncio.run(_main())


def test_password_remember_decline_and_no_entry_store_nothing(monkeypatch):
    """拒绝「不记住」（不发 password_remember）与无手输留档（凭据库自动
    登录后误触确认）都不写库。"""
    import openterminal.core as cmod
    from openterminal.core import ClientMsg

    core = _adhoc_core()
    stored: list = []
    monkeypatch.setattr(
        cmod, "store_password",
        lambda h, u, p, pw: stored.append((h, u, p, pw)) or True)

    async def _emit(msg):
        return None
    core.emit_msg = _emit

    async def _main():
        await core.feed_msg(ClientMsg(type="auth", auth_kind="password",
                                      text="pw", remember=False))
        # 拒绝：什么也不发 → 不写
        assert stored == []
        # 无留档（未手输过）：password_remember 是 no-op
        core._pw_last_entered = None
        await core.feed_msg(ClientMsg(type="auth",
                                      auth_kind="password_remember"))
        assert stored == []

    asyncio.run(_main())


def test_password_remember_store_failure_is_visible(monkeypatch):
    """凭据库写失败：返回 False 且经 status 可见（「以为记住了其实没记住」
    不再静默）。"""
    import openterminal.core as cmod
    from openterminal.core import ClientMsg

    core = _adhoc_core()
    msgs: list = []
    monkeypatch.setattr(cmod, "store_password", lambda *a, **k: False)

    async def _emit(msg):
        msgs.append(msg)
    core.emit_msg = _emit

    async def _main():
        await core.feed_msg(ClientMsg(type="auth", auth_kind="password",
                                      text="pw", remember=False))
        await core.feed_msg(ClientMsg(type="auth",
                                      auth_kind="password_remember"))
        assert any(m.type == "status" and "凭据库" in m.text for m in msgs)

    asyncio.run(_main())
