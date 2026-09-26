import asyncio
import sys

import pytest

# 模块级跳过须在 import local_pty 之前：Windows 上 fcntl 不存在，
# 顶层导入会直接 ImportError，pytestmark 的 skipif 来不及生效
if sys.platform == "win32":
    pytest.skip("本地 PTY 仅支持 macOS/Linux", allow_module_level=True)

from openterminal.local_pty import LocalPtySession


@pytest.fixture
async def session():
    s = LocalPtySession()
    await s.start()
    try:
        yield s
    finally:
        await s.close()


async def test_simple_run(session):
    r = await session.run("echo hello")
    assert r.exit_code == 0
    assert "hello" in r.output


async def test_persistent_state_cd_and_export(session):
    r1 = await session.run("cd /tmp")
    assert r1.exit_code == 0
    r2 = await session.run("pwd")
    assert "/tmp" in r2.output and r2.cwd == "/tmp"
    await session.run("export OT_MARKER=abc123")
    r3 = await session.run("echo $OT_MARKER")
    assert "abc123" in r3.output


async def test_shell_exit_recovers(session):
    r = await session.run("exit 7")
    assert r.reconnected is True or r.exit_code in (7, 124)
    r2 = await session.run("echo alive")
    assert r2.exit_code == 0 and "alive" in r2.output


async def test_stderr_and_failure(session):
    r = await session.run("ls /no/such/path_xyz")
    assert r.exit_code != 0
    assert "No such" in r.output or "no such" in r.output.lower()


async def test_timeout_kills_and_recovers(session):
    r = await session.run("sleep 30", timeout=2)
    assert r.exit_code in (124, 130)
    r2 = await session.run("echo recovered")
    assert r2.exit_code == 0


async def test_on_output_streams(session):
    chunks: list[str] = []
    await session.run("printf 'a\\nb\\nc\\n'", on_output=chunks.append)
    assert "".join(chunks).count("\n") >= 2


async def test_concurrent_runs_are_serialized(session):
    # 回归：模型一轮并行发起多个 execute 时，单条 PTY 必须把命令串行化，
    # 否则两条哨兵流互相截胡（输出互吞、命令拼坏、超时重置）
    r1, r2 = await asyncio.gather(
        session.run("echo concurrent-one"),
        session.run("sleep 0.3; echo concurrent-two"),
    )
    assert r1.exit_code == 0 and "concurrent-one" in r1.output
    assert "concurrent-two" not in r1.output
    assert r2.exit_code == 0 and "concurrent-two" in r2.output
    assert "concurrent-one" not in r2.output
