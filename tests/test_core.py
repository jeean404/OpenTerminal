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
