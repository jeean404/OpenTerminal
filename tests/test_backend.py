import asyncio
import sys
from pathlib import Path

import pytest

from openterminal.agent.backend import PtyShellBackend
from openterminal.session.base import CommandResult

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="PTY 仅 POSIX")


class FakeSession:
    def __init__(self):
        self.cwd = "/tmp"
        self.last = ""

    async def run(self, command, *, timeout=None, on_output=None):
        self.last = command
        if command == "fail":
            return CommandResult(output="[stderr] boom", exit_code=2,
                                 truncated=False, cwd="/tmp")
        return CommandResult(output="ok", exit_code=0, truncated=False, cwd="/home/u")


async def test_aexecute_delegates_and_keeps_file_root():
    """execute 回报的 cwd 不改文件根：虚拟路径 /x 的含义必须全程稳定；
    且远端 shell 的 cwd 灌进来会把根打成无盘符路径（真机 write_file ×失败）。
    根目录选型与漂移回归见 tests/test_backend_root.py。"""
    s = FakeSession()
    b = PtyShellBackend(s, root_dir="/tmp")
    r = await b.aexecute("pwd")
    assert r.exit_code == 0 and r.output == "ok"
    assert b.cwd == Path("/tmp").resolve()
    assert s.last == "pwd"


async def test_failure_passes_through():
    b = PtyShellBackend(FakeSession(), root_dir="/tmp")
    r = await b.aexecute("fail")
    assert r.exit_code == 2 and "boom" in r.output


def test_sync_execute_without_running_loop():
    s = FakeSession()
    b = PtyShellBackend(s, root_dir="/tmp")
    r = b.execute("pwd")
    assert r.exit_code == 0


async def test_start_and_finish_callbacks_fire():
    starts: list[str] = []
    finishes: list[tuple[str, int]] = []
    b = PtyShellBackend(FakeSession(), root_dir="/tmp")
    b.on_start = starts.append
    b.on_finish = lambda cmd, code: finishes.append((cmd, code))

    await b.aexecute("pwd")
    await b.aexecute("fail")

    assert starts == ["pwd", "fail"]
    assert finishes == [("pwd", 0), ("fail", 2)]
