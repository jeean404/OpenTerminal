"""SshPtySession 纯逻辑单测（无需真实 SSH 服务）。"""

import asyncssh


async def test_timeout_with_reconnect_maps_to_124(monkeypatch):
    """超时走断线重连路径成功：基类返回 _reconnected_result（exit 1），
    SSH 层须按超时语义改回 124——与 LocalPtySession 约定一致，否则无头
    消费方会把「命令超时没跑完」当普通远程失败（exit 1）误读。"""
    from openterminal.session.ssh import SshPtySession

    s = SshPtySession("h")          # 未 start：_proc None → 读路径直接断线

    async def fake_recover():
        return True

    monkeypatch.setattr(s, "_recover_connection", fake_recover)
    r = await s._handle_timeout()
    assert r.exit_code == 124
    assert r.reconnected is True
    assert "超时" in r.output and "重连" in r.output   # 两段语义都在


async def test_timeout_without_reconnect_keeps_124(monkeypatch):
    """重连失败：基类原生 124 超时语义不变（override 只接管 reconnected 分支）。"""
    from openterminal.session.ssh import SshPtySession

    s = SshPtySession("h")

    async def fake_recover():
        return False

    monkeypatch.setattr(s, "_recover_connection", fake_recover)
    r = await s._handle_timeout()
    assert r.exit_code == 124
    assert r.reconnected is False
    assert "超时" in r.output


async def test_connect_retries_transient_handshake_failure(monkeypatch):
    from openterminal.session import ssh as ssh_module
    from openterminal.session.ssh import SshPtySession

    session = SshPtySession("h")
    session._config_paths = []
    connection = object()
    calls = 0
    delays = []

    async def fake_connect(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise asyncssh.ConnectionLost("temporary handshake failure")
        return connection

    async def no_wait(delay):
        delays.append(delay)

    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    monkeypatch.setattr(ssh_module.asyncio, "sleep", no_wait)
    result = await session._connect_one(
        host="h", username=None, port=None, password=None)

    assert result is connection
    assert calls == 2
    assert delays == [0.25]


async def test_connect_stops_after_retry_limit(monkeypatch):
    from openterminal.session import ssh as ssh_module
    from openterminal.session.ssh import SshPtySession

    session = SshPtySession("h")
    session._config_paths = []
    calls = 0

    async def fake_connect(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise asyncssh.ConnectionLost("still unavailable")

    async def no_wait(_delay):
        return None

    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    monkeypatch.setattr(ssh_module.asyncio, "sleep", no_wait)

    try:
        await session._connect_one(
            host="h", username=None, port=None, password=None)
    except asyncssh.ConnectionLost:
        pass
    else:
        raise AssertionError("connection failure should be propagated")
    assert calls == 3


async def test_connect_does_not_retry_authentication_failure(monkeypatch):
    from openterminal.session import ssh as ssh_module
    from openterminal.session.ssh import SshPtySession

    session = SshPtySession("h")
    session._config_paths = []
    calls = 0
    prompts = []
    delays = []

    async def fake_connect(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise asyncssh.PermissionDenied("invalid credentials")

    def fake_prompt(label):
        prompts.append(label)
        return "wrong-password"

    async def no_wait(delay):
        delays.append(delay)

    session._ask_password = fake_prompt
    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    monkeypatch.setattr(ssh_module.asyncio, "sleep", no_wait)

    try:
        await session._connect_one(
            host="h", username=None, port=None, password=None)
    except asyncssh.PermissionDenied:
        pass
    else:
        raise AssertionError("authentication failure should be propagated")
    assert calls == 4
    assert len(prompts) == 3
    assert delays == [], "authentication errors must not use handshake backoff"
