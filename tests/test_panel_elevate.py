"""panel_elevate：以另一个用户的身份开 SFTP（sudo 拉起 sftp-server）。

fake 按 asyncssh **真实 API 面**写：``conn.run`` 返回 ``SSHCompletedProcess``
形状的对象（exit_status / stdout / stderr），``conn.create_process`` 返回带
``stdin``（write/drain）、``stdout``、``kill()`` 的进程对象。
``asyncssh.sftp.start_sftp_client`` 换成桩——真握手要真机，这里只钉住
「谁被 sudo 拉起来、密码有没有赶在握手前喂进去」。
"""

import pytest

from openterminal.web import panel_elevate
from openterminal.web.panel_elevate import (
    ElevateError, find_sftp_server, open_elevated_sftp,
)

_opened = []


class FakeResult:
    """asyncssh.SSHCompletedProcess 的形状。"""

    def __init__(self, exit_status=0, stdout="", stderr=""):
        self.exit_status = exit_status
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = exit_status


class FakeStdin:
    def __init__(self):
        self.written = b""

    def write(self, data):
        self.written += data

    async def drain(self):
        pass


class FakeProcess:
    """asyncssh.SSHClientProcess 的形状（这里只用到 stdin/stdout/kill）。"""

    def __init__(self):
        self.stdin = FakeStdin()
        self.stdout = object()
        self.killed = False

    def kill(self):
        self.killed = True


class FakeConn:
    """asyncssh.SSHClientConnection 的形状：run / create_process / start_sftp_client。"""

    def __init__(self, results):
        _opened.clear()
        self.results = list(results)
        self.run_cmds = []
        self.processes = []
        self.started_plain = 0

    async def run(self, cmd, check=False, input=None, encoding="utf-8"):
        self.run_cmds.append(list(cmd))
        return self.results.pop(0)

    async def create_process(self, cmd, encoding=None):
        self.processes.append(list(cmd))
        proc = FakeProcess()
        _opened.append(proc)
        return proc

    async def start_sftp_client(self):
        self.started_plain += 1
        return "plain-sftp"


@pytest.fixture
def handshake(monkeypatch):
    """把 asyncssh 的 SFTP 握手换成桩，回传「写进协议流的第一批字节」。"""
    seen = {}

    async def fake_start_sftp_client(conn, loop, utf8, reader, writer,
                                     path_encoding, path_errors, version):
        seen["writer"] = writer
        return "elevated-sftp"

    monkeypatch.setattr(panel_elevate._asftp, "start_sftp_client",
                        fake_start_sftp_client)
    return seen


SUDO_OK = FakeResult()
NEEDS_PW = FakeResult(1, "", "sudo: a password is required")
DENIED = FakeResult(1, "", "Sorry, user xiaojian is not allowed to execute")
SFTP_FOUND = FakeResult(0, "/usr/lib/openssh/sftp-server\n")
WHO_ROOT = FakeResult(0, "root\n")
WHO_XIAOJIAN = FakeResult(0, "xiaojian\n")


async def test_skips_sudo_when_already_that_user():
    conn = FakeConn([WHO_ROOT])
    sftp = await open_elevated_sftp(conn, "root", "pw")
    assert sftp == "plain-sftp"
    assert conn.started_plain == 1, "已是目标用户就不该惊动 sudo"
    assert not conn.processes


async def test_passwordless_sudo_runs_sftp_server_directly(handshake):
    conn = FakeConn([WHO_XIAOJIAN, SUDO_OK, SFTP_FOUND])
    sftp = await open_elevated_sftp(conn, "root", "pw")
    assert sftp == "elevated-sftp"
    assert conn.processes == [["sudo", "-n", "-u", "root",
                               "/usr/lib/openssh/sftp-server"]]
    assert handshake["writer"].written == b"", "免密路径不许往协议流里塞密码"


async def test_passworded_sudo_feeds_password_before_handshake(handshake):
    conn = FakeConn([WHO_XIAOJIAN, NEEDS_PW, SFTP_FOUND])
    sftp = await open_elevated_sftp(conn, "root", "hunter2")
    assert sftp == "elevated-sftp"
    assert conn.processes == [["sudo", "-S", "-p", "", "-u", "root",
                               "/usr/lib/openssh/sftp-server"]]
    # 密码必须是握手前写进去的第一批字节，否则会被 sftp-server 当协议首包
    assert handshake["writer"].written == b"hunter2\n"


async def test_sudo_denied_is_reported_not_swallowed():
    conn = FakeConn([WHO_XIAOJIAN, DENIED])
    with pytest.raises(ElevateError) as exc:
        await open_elevated_sftp(conn, "root", "pw")
    assert exc.value.code == "sudo_denied"
    assert "not allowed" in str(exc.value)
    assert not conn.processes, "sudo 被拒就不该再开 exec 通道"


async def test_sudo_wants_password_but_none_available():
    conn = FakeConn([WHO_XIAOJIAN, NEEDS_PW])
    with pytest.raises(ElevateError) as exc:
        await open_elevated_sftp(conn, "root", None)
    assert exc.value.code == "sudo_password"
    assert not conn.processes, "缺密码要早报，别白摸一趟 sftp-server"


async def test_missing_sftp_server_is_reported():
    conn = FakeConn([WHO_XIAOJIAN, SUDO_OK,
                     FakeResult(1, "", "sh: not found")])
    with pytest.raises(ElevateError) as exc:
        await open_elevated_sftp(conn, "root", "pw")
    assert exc.value.code == "no_sftp_server"


async def test_find_sftp_server_returns_first_hit():
    conn = FakeConn([FakeResult(0, "/usr/libexec/openssh/sftp-server")])
    assert await find_sftp_server(conn) == "/usr/libexec/openssh/sftp-server"


async def test_handshake_failure_kills_process_and_reports(monkeypatch):
    conn = FakeConn([WHO_XIAOJIAN, SUDO_OK, SFTP_FOUND])

    async def boom(*args, **kwargs):
        raise OSError("channel closed")

    monkeypatch.setattr(panel_elevate._asftp, "start_sftp_client", boom)
    with pytest.raises(ElevateError) as exc:
        await open_elevated_sftp(conn, "root", "pw")
    assert exc.value.code == "elevate_failed"
    assert _opened, "进程开过"
    # 半死的 exec 通道必须收掉，否则 SSH 连接会一直挂着
    assert all(pr.killed for pr in _opened)
