"""core.messages 协议层独立可导入、可构造（Task 1 引入）。"""
import pytest

from openterminal.core.messages import (
    CHANNEL_DEAD_EC,
    CHANNEL_DEAD_MSG,
    ClientMsg,
    InteractiveRunner,
    PasswordCancelled,
    ServerMsg,
)


def test_server_msg_fields():
    m = ServerMsg(type="closed", tab_id="t1", message="bye")
    assert m.type == "closed"
    assert m.tab_id == "t1"
    assert m.message == "bye"
    assert m.event is None
    assert m.models is None


def test_client_msg_fields():
    m = ClientMsg(type="raw", data=b"ls\r")
    assert m.type == "raw"
    assert m.data == b"ls\r"
    assert m.mirror is None
    assert m.dirty is False


def test_channel_dead_constants():
    assert CHANNEL_DEAD_EC == 126
    assert "AI 集成通道" in CHANNEL_DEAD_MSG


def test_password_cancelled_is_exception():
    assert issubclass(PasswordCancelled, ConnectionError)


def test_runner_references_worker():
    class W:  # 最小鸭子：仅满足 __init__ 所需
        pass

    w = W()
    r = InteractiveRunner(w)
    assert r.w is w
    assert r.cwd == ""
