"""SshPtySession 跳板机连接（tunnel）与认证回调注入。"""

import asyncio

import asyncssh

from openterminal.connections import JumpHost
from openterminal.ssh_pty import SshPtySession

PWD_REPLY = [b"__OT_BEGIN__\r\n/tmp\r\n__OT_END__0__/tmp__\r\n"]


class _FakeStdin:
    def write(self, data):
        pass

    async def drain(self):
        return None

    def close(self):
        pass


class FakeProc:
    def __init__(self, reply):
        self._reply = list(reply)
        self.closed = False
        self.stdin = _FakeStdin()
        self.stdout = self  # _read_some 走 self._proc.stdout.read

    async def read(self, n):
        if self._reply:
            return self._reply.pop(0)
        raise EOFError("EOF")

    def close(self):
        self.closed = True


class FakeConn:
    def __init__(self, reply=None):
        self._reply = list(reply) if reply is not None else list(PWD_REPLY)
        self.closed = False

    async def create_process(self, **kw):
        return FakeProc(self._reply)

    def close(self):
        self.closed = True


async def test_connect_one_password_and_tunnel(monkeypatch):
    calls = []

    async def fake_connect(host, **kw):
        calls.append((host, kw))
        return object()

    # _connect_one 内部 `import asyncssh` 解析到同一模块对象，patch 生效
    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    s = SshPtySession("target")
    s._config_paths = []
    await s._connect_one(host="target", username="root", port=None,
                         password="tpw", tunnel=object(),
                         record_last=lambda pw: None)
    host, kw = calls[0]
    assert host == "target"
    assert kw["password"] == "tpw"
    assert kw["tunnel"] is not None
    assert kw["keepalive_interval"] == 30


async def test_connect_one_password_retry_uses_injected_prompt(monkeypatch):
    async def fake_connect(host, **kw):
        if not hasattr(fake_connect, "n"):
            fake_connect.n = 0
        fake_connect.n += 1
        if fake_connect.n == 1:
            raise asyncssh.PermissionDenied(reason="bad password")
        return FakeConn()

    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    s = SshPtySession("target")
    s._config_paths = []

    async def ask(label):
        return "secret"

    s._ask_password = ask
    seen = {}
    conn = await s._connect_one(host="target", username="root", port=None,
                                password=None,
                                record_last=lambda pw: seen.update(pw=pw))
    assert conn is not None
    assert seen == {"pw": "secret"}
    assert fake_connect.n == 2


async def test_start_connects_jump_then_target_with_tunnel(monkeypatch):
    jump = JumpHost(name="bastion01", host="10.0.0.5", user="admin", port=2222)
    s = SshPtySession("10.0.0.20", username="root", password="tpw",
                      jump=jump, jump_password="jpw")
    calls = []

    async def fake_connect(host, **kw):
        calls.append((host, kw))
        return FakeConn()

    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    await s.start()
    assert calls[0][0] == "10.0.0.5"
    assert calls[0][1]["password"] == "jpw"
    assert calls[1][0] == "10.0.0.20"
    assert calls[1][1]["password"] == "tpw"
    # 目标连接带着跳板机连接作为 tunnel 传入（跳板机连接自身无 tunnel）
    assert "tunnel" not in calls[0][1]
    assert calls[1][1]["tunnel"] is not None
    assert s.cwd == "/tmp"
    await s.close()
    assert s._conn is None and s._jump_conn is None


async def test_ssh_resize_does_not_await_sync_change_terminal_size():
    # 回归：asyncssh change_terminal_size 是同步方法，await 它会 TypeError
    # （object NoneType can't be used in 'await'），raw/透传模式 resize 会炸
    s = SshPtySession("h")
    calls = []

    class FakeProc:
        def change_terminal_size(self, width, height):
            calls.append((width, height))

    s._proc = FakeProc()
    await s.resize(rows=30, cols=100)
    assert calls == [(100, 30)]  # cols=width, rows=height


async def test_start_reconnect_reuses_last_password(monkeypatch):
    # 回归：重连 start() 必须用 last_password（本次实际使用/重输的密码），
    # 而不是构造时的 password——否则远端 shell 退出触发自动重连会重新要密码
    s = SshPtySession("10.0.0.20", username="root", password="stale")
    s.last_password = "actual"
    calls = []

    async def fake_connect(host, **kw):
        calls.append((host, kw))
        return FakeConn()

    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    await s.start()
    assert calls[0][1]["password"] == "actual"


async def test_start_reconnect_reuses_last_jump_password(monkeypatch):
    # 同上：跳板机重连用 last_jump_password
    jump = JumpHost(name="bastion01", host="10.0.0.5", user="admin")
    s = SshPtySession("10.0.0.20", username="root", jump=jump,
                      jump_password="stale-j")
    s.last_jump_password = "actual-j"
    calls = []

    async def fake_connect(host, **kw):
        calls.append((host, kw))
        return FakeConn()

    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    await s.start()
    assert calls[0][1]["password"] == "actual-j"


async def test_open_session_passes_jump_and_keyring(monkeypatch):
    from openterminal.config import TargetConfig
    from openterminal.connections import (
        JumpHost, open_session, save_jump_hosts,
    )
    import openterminal.secrets_store as secrets_mod

    save_jump_hosts([JumpHost(name="bastion01", host="10.0.0.5", user="admin")])
    seen = {}

    async def fake_start(self):
        seen["jump"] = self.jump
        seen["jump_password"] = self.jump_password
        seen["password"] = self.password

    monkeypatch.setattr("openterminal.ssh_pty.SshPtySession.start", fake_start)
    # open_session 内 `from .secrets_store import load_password` 在调用时取模块属性
    monkeypatch.setattr(secrets_mod, "load_password", lambda h, u, p: "jpw-store")

    t = TargetConfig(name="web01", mode="ssh", host="10.0.0.20",
                     user="root", jump="bastion01")
    await open_session(t)
    assert seen["jump"].name == "bastion01"
    assert seen["jump_password"] == "jpw-store"
    assert seen["password"] is None


# --- 断线重连钩子 ---

async def test_recover_connection_fires_on_reconnect(monkeypatch):
    """_recover_connection 成功后必须触发 on_reconnect 回调（历史注入挂点）。"""
    s = SshPtySession("h")
    events = []

    async def fake_close():
        events.append("close")

    async def fake_start():
        events.append("start")

    async def cb():
        events.append("cb")

    monkeypatch.setattr(s, "close", fake_close)
    monkeypatch.setattr(s, "start", fake_start)
    s.on_reconnect = cb
    assert await s._recover_connection() is True
    assert events == ["close", "start", "cb"]


async def test_recover_connection_without_callback(monkeypatch):
    s = SshPtySession("h")

    async def fake_start():
        pass

    monkeypatch.setattr(s, "close", AsyncNoop())
    monkeypatch.setattr(s, "start", fake_start)
    assert await s._recover_connection() is True   # 无回调也不报错


class AsyncNoop:
    def __call__(self):
        return _noop()


async def _noop():
    pass


async def test_recover_failure_no_callback(monkeypatch):
    s = SshPtySession("h")
    fired = []

    async def cb():
        fired.append(True)

    async def fake_start():
        raise RuntimeError("boom")

    monkeypatch.setattr(s, "close", AsyncNoop())
    monkeypatch.setattr(s, "start", fake_start)
    s.on_reconnect = cb
    assert await s._recover_connection() is False
    assert fired == []
