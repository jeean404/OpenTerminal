"""panel_elevate 的真机验证：低权账号登录，提权到目标用户看它的目录。

SFTP 换不了用户这件事只有真机能证：同一份凭据，不提权时 /root 读不了、
提权后能读，才算「sudo 拉起 sftp-server」这条路真的通了。

跑法（需要一台低权账号能 sudo 的 Linux 主机）::

    OT_TEST_SSH=1 \
    OT_TEST_SSH_HOST=<host> OT_TEST_SSH_PORT=22 \
    OT_TEST_SSH_USER=xiaojian OT_TEST_SSH_PASSWORD=<pw> \
    OT_TEST_ELEVATE_USER=root \
    python -m pytest tests/test_panel_elevate_live.py -q
"""

import os
from contextlib import suppress

import pytest

from openterminal.web.files_api import connect_panel

pytestmark = pytest.mark.ssh

HOST = os.environ.get("OT_TEST_SSH_HOST", "127.0.0.1")
PORT = int(os.environ["OT_TEST_SSH_PORT"]) if os.environ.get("OT_TEST_SSH_PORT") else None
USER = os.environ.get("OT_TEST_SSH_USER") or os.environ.get("USER") or ""
PASSWORD = os.environ.get("OT_TEST_SSH_PASSWORD", "")
ELEVATE_TO = os.environ.get("OT_TEST_ELEVATE_USER", "root")

_ENABLED = os.environ.get("OT_TEST_SSH") == "1" and bool(USER)
_needs = "设置 OT_TEST_SSH=1 / OT_TEST_SSH_HOST / OT_TEST_SSH_USER 后运行"


def _target_home() -> str:
    """目标用户的家目录：root 是 /root，其余按 /home/<user>。"""
    return "/root" if ELEVATE_TO == "root" else f"/home/{ELEVATE_TO}"


async def _open(elevate_to):
    conn, sftp = await connect_panel(
        host=HOST, port=PORT, user=USER, password=PASSWORD or None,
        confirm_host_key=True, elevate_to=elevate_to)
    return conn, sftp


@pytest.mark.skipif(not _ENABLED, reason=_needs)
async def test_plain_sftp_cannot_list_target_home():
    """对照组：不提权就读不到目标用户的家目录——否则下面那条不算数。"""
    if USER == ELEVATE_TO:
        pytest.skip("登录身份就是目标用户，对照组无意义")
    conn, sftp = await _open(None)
    try:
        with pytest.raises(Exception):
            await sftp.readdir(_target_home())
    finally:
        conn.close()


@pytest.mark.skipif(not _ENABLED, reason=_needs)
async def test_elevated_sftp_lists_target_home():
    """提权后能列出目标用户的家目录，且协议仍是 SFTP（readdir 直接可用）。"""
    conn, sftp = await _open(ELEVATE_TO)
    try:
        path = _target_home()
        names = await sftp.readdir(path)
        assert names, f"{path} 列得出内容"
        assert any(n.filename not in (".", "..") for n in names)
    finally:
        conn.close()


@pytest.mark.skipif(not _ENABLED or not PASSWORD, reason=_needs)
async def test_elevated_write_and_read_roundtrip(tmp_path):
    """提权后的读写不是只读特例：写进去再读回来。"""
    conn, sftp = await _open(ELEVATE_TO)
    remote = (f"/tmp/.ot-elevate-{os.getpid()}.txt")
    try:
        async with sftp.open(remote, "wb") as f:
            await f.write(b"elevated")
        async with sftp.open(remote, "rb") as f:
            data = await f.read()
        assert data == b"elevated"
    finally:
        with suppress(Exception):
            await sftp.remove(remote)
        conn.close()
