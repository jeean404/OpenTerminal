"""SshPtySession SFTP 客户端生命周期单测（无需真实 SSH 服务）。"""

import pytest

from openterminal.session.ssh import SshPtySession


class FakeSftp:
    def __init__(self, tag):
        self.tag = tag
        self.exited = False

    def exit(self):
        self.exited = True


class FakeConn:
    def __init__(self, tag):
        self.tag = tag
        self.opens = 0

    async def start_sftp_client(self):
        self.opens += 1
        return FakeSftp(f"{self.tag}-sftp{self.opens}")


async def test_sftp_lazy_open_and_cache():
    """首次调用打开 SFTP 客户端；后续调用复用缓存，不重复开通道。"""
    s = SshPtySession("h")
    conn = FakeConn("c1")
    s._conn = conn
    sftp1 = await s.sftp_client()
    sftp2 = await s.sftp_client()
    assert sftp1 is sftp2
    assert conn.opens == 1


async def test_sftp_reopens_after_reconnect():
    """断线重连会重建 _conn：按对象比对失效旧 SFTP 客户端并重开。"""
    s = SshPtySession("h")
    c1, c2 = FakeConn("c1"), FakeConn("c2")
    s._conn = c1
    old = await s.sftp_client()
    s._conn = c2                    # 模拟 _recover_connection 重建
    new = await s.sftp_client()
    assert new is not old
    assert old.exited               # 旧客户端被主动废弃
    assert c1.opens == 1 and c2.opens == 1


async def test_close_exits_sftp():
    """close() 先退出 SFTP 客户端再关连接，缓存一并清空。"""
    s = SshPtySession("h")
    s._conn = FakeConn("c1")
    sftp = await s.sftp_client()
    await s.close()
    assert sftp.exited
    assert s._conn is None and s._sftp is None and s._sftp_conn is None


async def test_sftp_requires_connection():
    """未连接时给出明确错误，而不是钻进 None.start_sftp_client 的 AttributeError。"""
    s = SshPtySession("h")
    with pytest.raises(RuntimeError):
        await s.sftp_client()
