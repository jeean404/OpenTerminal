import os

import pytest

from openterminal.ssh_pty import SshPtySession

pytestmark = pytest.mark.ssh


@pytest.mark.skipif(os.environ.get("OT_TEST_SSH") != "1",
                    reason="设置 OT_TEST_SSH=1 且本机 sshd 可用时运行")
async def test_ssh_session_basic():
    # 可用 OT_TEST_SSH_HOST / OT_TEST_SSH_PORT 指向临时 sshd（如 127.0.0.1:2222）
    host = os.environ.get("OT_TEST_SSH_HOST", "127.0.0.1")
    port_env = os.environ.get("OT_TEST_SSH_PORT")
    port = int(port_env) if port_env else None
    s = SshPtySession(
        host,
        username=os.environ.get("USER"),
        port=port,
        # 显式 opt-in 的测试环境：未知主机密钥自动接受（TOFU）
        host_key_prompt=lambda _msg: True,
    )
    await s.start()
    try:
        r = await s.run("echo hi && pwd")
        assert r.exit_code == 0 and "hi" in r.output and r.cwd
    finally:
        await s.close()


@pytest.mark.skipif(
    os.environ.get("OT_TEST_SSH") != "1"
    or not os.environ.get("OT_TEST_SSH_PASSWORD"),
    reason="设置 OT_TEST_SSH=1 且 OT_TEST_SSH_PASSWORD 指向密码时运行",
)
async def test_ssh_session_stored_password():
    # 记住的密码（系统凭据库取回）直接传入：不应触发交互式密码提示
    pw = os.environ["OT_TEST_SSH_PASSWORD"]
    s = SshPtySession(
        os.environ.get("OT_TEST_SSH_HOST", "127.0.0.1"),
        username=os.environ.get("USER"),
        port=int(os.environ["OT_TEST_SSH_PORT"]) if os.environ.get("OT_TEST_SSH_PORT") else None,
        host_key_prompt=lambda _msg: True,
        password=pw,
    )
    await s.start()
    try:
        r = await s.run("echo ok")
        assert r.exit_code == 0 and "ok" in r.output
        assert s.last_password == pw
    finally:
        await s.close()
