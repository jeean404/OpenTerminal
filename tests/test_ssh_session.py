"""SshPtySession 纯逻辑单测（无需真实 SSH 服务）。"""


async def test_timeout_with_reconnect_maps_to_124(monkeypatch):
    """超时走断线重连路径成功：基类返回 _reconnected_result（exit 1），
    SSH 层须按超时语义改回 124——与 LocalPtySession 约定一致，否则无头
    消费方会把「命令超时没跑完」当普通远程失败（exit 1）误读。"""
    from openterminal.ssh_pty import SshPtySession

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
    from openterminal.ssh_pty import SshPtySession

    s = SshPtySession("h")

    async def fake_recover():
        return False

    monkeypatch.setattr(s, "_recover_connection", fake_recover)
    r = await s._handle_timeout()
    assert r.exit_code == 124
    assert r.reconnected is False
    assert "超时" in r.output
