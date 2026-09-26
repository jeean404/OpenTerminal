import asyncio
import sys

import pytest

from openterminal.backend import PtyShellBackend
from openterminal.shell_session import CommandResult

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


async def test_aexecute_delegates_and_syncs_cwd():
    s = FakeSession()
    b = PtyShellBackend(s, root_dir="/tmp")
    r = await b.aexecute("pwd")
    assert r.exit_code == 0 and r.output == "ok"
    assert str(b.cwd) == "/home/u"
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
