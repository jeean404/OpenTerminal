"""CLI 终端前端骨架单测（Task 3）：raw 输入泵 + 串行渲染 outbox + 生命周期。

模式取自 tests/test_web_worker.py 头部（FakeSession/PassthroughSession/_wait），
按计划复制为本文件私有件（test_web_worker.py 是一行不改的受保护文件，不做
跨测试文件 import；tests/fakes.py 是 langchain 假模型专用，不适合放会话假件）。
monkeypatch 目标是 openterminal.core 模块命名空间（open_session/probe_profile/
build_agent/load_password），不是 web.worker。非 tty（pytest）下 TermFrontend
按 sys.stdin.isatty() 门控跳过 termios；reader/writer 用测试注入的假件。
"""
import asyncio
import os
import pty
import signal
import sys

import pytest

import openterminal.core as cmod
import openterminal.term_frontend as tmod
from openterminal.config import Config, TargetConfig
from openterminal.core import ClientMsg, ServerMsg
from openterminal.sysprobe import SystemProfile
from openterminal.term_frontend import CliCore, TermFrontend


class FakeSession:
    """假 PTY：run() 立即返回无标记输出 → 核心快速落定纯直通（非交互），
    避开 8s 探测等待（同 test_web_worker 的 ready<2s 模式）。"""

    def __init__(self):
        self.cwd = "/tmp"
        self.calls = []

    async def start(self):
        pass

    async def run(self, command, *, timeout=None, on_output=None):
        self.calls.append(("run", command))
        from openterminal.shell_session import CommandResult
        return CommandResult(output="hello", exit_code=0,
                             truncated=False, cwd="/tmp")

    async def send_raw(self, data):
        self.calls.append(("raw", data))

    async def resize(self, rows, cols):
        self.calls.append(("resize", rows, cols))

    async def _read_some(self, idle_timeout):
        await asyncio.sleep(0.01)
        raise asyncio.TimeoutError()

    async def close(self):
        self.calls.append(("close", None))


class PassthroughSession(FakeSession):
    """透传测试用的脚本化 PTY：push() 喂字节，_read_some 依序消费。"""

    def __init__(self):
        super().__init__()
        self.feed = []

    def push(self, data):
        self.feed.append(data)

    async def _read_some(self, idle_timeout):
        if self.feed:
            await asyncio.sleep(0)
            return self.feed.pop(0)
        await asyncio.sleep(0.02)
        raise asyncio.TimeoutError()


def _profile():
    return SystemProfile(host="web01", os_family="linux", distro="Debian",
                         version="", kernel="", pkg_manager="apt",
                         service_mgr="systemd", shell="/bin/bash", tools={})


def _eof_reader():
    async def _r():
        return b""
    return _r


async def _never_reader():
    await asyncio.sleep(3600)
    return b""


def _patch_core_ns(monkeypatch, sess):
    """monkeypatch openterminal.core 命名空间（不是 web.worker）。"""
    async def _fake_open(*a, **k):
        return sess

    async def _fake_probe(s, h):
        return _profile()

    monkeypatch.setattr(cmod, "load_password", lambda *a: None)
    monkeypatch.setattr(cmod, "open_session", _fake_open)
    monkeypatch.setattr(cmod, "probe_profile", _fake_probe)
    monkeypatch.setattr(cmod, "build_agent",
                        lambda *a, **k: (None, set(), None))


def _cfg():
    cfg = Config.load()
    cfg.targets["web01"] = TargetConfig(name="web01", mode="ssh",
                                        host="10.0.0.20", user="root")
    return cfg


async def _make_env(monkeypatch, reader=None, session=None):
    """组 CliCore/TermFrontend（两段构造，同 Task 6 形状）+ 假 writer。"""
    sess = session if session is not None else FakeSession()
    _patch_core_ns(monkeypatch, sess)
    core = CliCore(_cfg(), "web01", frontend=None)
    frontend = TermFrontend(core, reader=reader or _eof_reader())
    written = []
    frontend._writer = lambda d: written.append(d)
    core._frontend = frontend
    return core, frontend, sess, written


async def _wait(pred, timeout=2):
    """轮询任意谓词直到为真（同 test_web_worker._wait）。"""
    async def _poll():
        while not pred():
            await asyncio.sleep(0.01)
    await asyncio.wait_for(_poll(), timeout=timeout)


def _record_restore(monkeypatch):
    """monkeypatch tmod._restore_input 记录调用（非 tty 下 state=None）。"""
    recorded = []
    monkeypatch.setattr(tmod, "_restore_input", lambda st: recorded.append(st))
    return recorded


# --- 计划 Step 1 的 6 例 ---

async def test_pty_bytes_stream_to_writer(monkeypatch):
    """PassthroughSession.push 的字节经 核心泵 → CliCore.emit_bytes →
    前端 outbox → writer（唯一显示管线），按序到达。"""
    sess = PassthroughSession()
    core, frontend, _, written = await _make_env(monkeypatch,
                                                 reader=_never_reader,
                                                 session=sess)
    run_task = asyncio.create_task(frontend.run())
    await asyncio.wait_for(core.connected.wait(), timeout=2)
    sess.push(b"hello\r\n$ ")
    await _wait(lambda: b"hello\r\n$ " in b"".join(written))
    frontend._stop.set()
    await asyncio.wait_for(run_task, timeout=2)
    await core.close()


async def test_keys_reach_session_raw(monkeypatch):
    """reader 依序产出 [b"echo hi\\r", b""]：字节经 feed_input 进 PTY，
    EOF 停泵、run() 返回。（EOF 前等 connected：_dispatch 在 _connect 之后
    才消费 _inbox，先停 run 会与核心建连竞态。）"""
    core, frontend, sess, _ = await _make_env(monkeypatch)
    chunks = [b"echo hi\r", b""]

    async def reader():
        if not chunks:
            return b""
        data = chunks.pop(0)
        if not chunks:      # 最后一块：等核心建连落定再放 EOF
            await asyncio.wait_for(core.connected.wait(), timeout=2)
        return data

    frontend._reader = reader
    await asyncio.wait_for(frontend.run(), timeout=4)
    await _wait(lambda: ("raw", b"echo hi\r") in sess.calls)
    await core.close()


async def test_initial_resize_sent(monkeypatch):
    """run() 启动即按 _term_size() 发初始 resize。"""
    monkeypatch.setattr(tmod, "_term_size", lambda: (40, 120))
    core, frontend, sess, _ = await _make_env(monkeypatch, reader=_never_reader)
    run_task = asyncio.create_task(frontend.run())
    await _wait(lambda: ("resize", 40, 120) in sess.calls)
    frontend._stop.set()
    await asyncio.wait_for(run_task, timeout=2)
    await core.close()


async def test_run_returns_on_closed(monkeypatch):
    """核心 close() → closed 消息经渲染 outbox → _stop → run() 返回；
    termios 还原函数被调用（finally），收尾换行已写。"""
    restored = _record_restore(monkeypatch)
    core, frontend, _, written = await _make_env(monkeypatch,
                                                 reader=_never_reader)
    run_task = asyncio.create_task(frontend.run())
    await asyncio.wait_for(core.connected.wait(), timeout=2)
    await core.close()
    await asyncio.wait_for(run_task, timeout=2)
    assert restored == [None]        # 非 tty（pytest）：state=None 也要走还原
    assert b"".join(written).endswith(b"\r\n")
    assert ("close", None) in core.session.calls
    # 核心 sender 对 None sink 空转，close 后按门闩退出（不泄漏协程）
    await _wait(lambda: core._sender is None or core._sender.done())


async def test_run_restores_termios_on_exception(monkeypatch):
    """reader 抛 RuntimeError → 泵死亡向外传播：run() 抛出，但 finally
    已还原 termios（Review Focus #1 异常路径）。"""
    restored = _record_restore(monkeypatch)

    async def _boom():
        raise RuntimeError("boom")

    core, frontend, _, _ = await _make_env(monkeypatch, reader=_boom)
    with pytest.raises(RuntimeError):
        await asyncio.wait_for(frontend.run(), timeout=2)
    assert restored == [None]
    await core.close()


async def test_resize_before_connect_is_safe(monkeypatch):
    """attach 前直接 feed_msg(resize)：入 _inbox 排队不炸，session None
    安全（Review Focus #6：启动即发 resize / SIGWINCH 随时触发）。"""
    sess = FakeSession()
    _patch_core_ns(monkeypatch, sess)
    core = CliCore(_cfg(), "web01", frontend=None)
    frontend = TermFrontend(core, reader=_eof_reader())
    written = []
    frontend._writer = lambda d: written.append(d)
    core._frontend = frontend
    await core.feed_msg(ClientMsg(type="resize", rows=10, cols=20))  # 不抛
    core.attach(None)
    await asyncio.wait_for(core.connected.wait(), timeout=2)
    await core.close()


# --- 追加覆盖（只加不减）---

async def test_clicore_emit_overrides_route_to_frontend_outbox(monkeypatch):
    """CliCore 三个 emit 出口全部进 frontend._outbox（含 _emit_nowait
    同步缝，AI token 流走它）；核心自身 outbox 不收货（sender 空转）。"""
    core, frontend, _, _ = await _make_env(monkeypatch)
    await core.emit_msg(ServerMsg(type="status", text="x"))
    await core.emit_bytes(b"pty")
    core._emit_nowait(ServerMsg(type="status", text="sync"))
    items = []
    while not frontend._outbox.empty():
        items.append(frontend._outbox.get_nowait())
    assert [k for k, _ in items] == ["msg", "bytes", "msg"]
    assert items[0][1].type == "status" and items[0][1].text == "x"
    assert items[1][1] == b"pty"
    assert items[2][1].text == "sync"
    assert core._outbox.empty()


async def test_eof_stops_run_cleanly(monkeypatch):
    """reader 首读即 EOF：run() 干净返回，不抛、还原被调、收尾换行写出。"""
    restored = _record_restore(monkeypatch)
    core, frontend, _, written = await _make_env(monkeypatch)  # 默认 EOF reader
    await asyncio.wait_for(frontend.run(), timeout=3)
    assert restored == [None]
    assert b"".join(written).endswith(b"\r\n")
    await core.close()


@pytest.mark.skipif(not hasattr(signal, "SIGWINCH"), reason="POSIX only")
async def test_sigwinch_feeds_resize(monkeypatch):
    """SIGWINCH → add_signal_handler 回调 → create_task(feed_msg(resize))
    → session.resize；run() 退出时 handler 已移除（Review Focus #1）。"""
    monkeypatch.setattr(tmod, "_term_size", lambda: (42, 100))
    core, frontend, sess, _ = await _make_env(monkeypatch, reader=_never_reader)
    run_task = asyncio.create_task(frontend.run())
    await asyncio.wait_for(core.connected.wait(), timeout=2)
    n0 = len([c for c in sess.calls if c[0] == "resize"])
    os.kill(os.getpid(), signal.SIGWINCH)
    await _wait(lambda: len([c for c in sess.calls
                             if c == ("resize", 42, 100)]) > n0)
    frontend._stop.set()
    await asyncio.wait_for(run_task, timeout=2)
    n = len([c for c in sess.calls if c[0] == "resize"])
    os.kill(os.getpid(), signal.SIGWINCH)      # handler 已移除 → 无新 resize
    await asyncio.sleep(0.05)
    assert len([c for c in sess.calls if c[0] == "resize"]) == n
    await core.close()


async def test_default_reader_reads_stdin_fd(monkeypatch):
    """默认 reader（POSIX add_reader + os.read 路径）从 sys.stdin fd 读字节。"""
    rfd, wfd = os.pipe()
    fake_stdin = os.fdopen(rfd, "rb", closefd=False)
    monkeypatch.setattr(sys, "stdin", fake_stdin)
    frontend = TermFrontend(None)               # 只测 reader 原语，不跑 run()
    reader = frontend._make_default_reader()
    os.write(wfd, b"abc")
    try:
        data = await asyncio.wait_for(reader(), timeout=2)
        assert data == b"abc"
    finally:
        asyncio.get_running_loop().remove_reader(rfd)
        os.close(wfd)
        fake_stdin.close()
        os.close(rfd)


async def test_tty_path_sets_and_restores_raw(monkeypatch):
    """sys.stdin.isatty() 为真时走 termios：_set_raw_input 置 raw、
    finally _restore_input 收到 (fd, attrs) 状态（Review Focus #1）。"""
    mfd, sfd = pty.openpty()

    class _TtyStdin:
        def isatty(self):
            return True

        def fileno(self):
            return sfd

    monkeypatch.setattr(sys, "stdin", _TtyStdin())
    restored = _record_restore(monkeypatch)
    core, frontend, _, _ = await _make_env(monkeypatch, reader=_never_reader)
    run_task = asyncio.create_task(frontend.run())
    await asyncio.sleep(0.05)
    assert not restored            # run 期间不还原
    frontend._stop.set()
    await asyncio.wait_for(run_task, timeout=2)
    try:
        assert len(restored) == 1
        state = restored[0]
        assert state is not None and state[0] == sfd
        import termios
        assert len(state[1]) == len(termios.tcgetattr(sfd))
    finally:
        os.close(sfd)
        os.close(mfd)
    await core.close()


# --- 存量密码路径（移植自旧 CLI test_switch_target_*，Task 6 换心后由
# core._connect 承接：凭据库存量密码随建连传给 open_session；现场重输
# 的写回由核心认证弹窗 remember 路径承接，见 test_web_worker.py）---


async def test_stored_password_passed_to_open_session(monkeypatch):
    """凭据库有记录：load_password 的存量密码作为 password 传给 open_session
    （旧 CLI test_switch_target_uses_stored_password 的首断言，核心侧口径）。"""
    captured: dict = {}

    async def fake_open(target, password=None, **kw):
        captured["password"] = password
        return FakeSession()

    monkeypatch.setattr(cmod, "load_password", lambda h, u, p: "old-pw")
    monkeypatch.setattr(cmod, "open_session", fake_open)
    monkeypatch.setattr(cmod, "probe_profile", lambda s, h: _profile())
    monkeypatch.setattr(cmod, "build_agent",
                        lambda *a, **k: (None, set(), None))
    core = CliCore(_cfg(), "web01", frontend=None)
    frontend = TermFrontend(core, reader=_never_reader)
    core._frontend = frontend
    run_task = asyncio.create_task(frontend.run())
    await _wait(lambda: "password" in captured, timeout=3)
    assert captured["password"] == "old-pw"
    frontend._stop.set()
    await asyncio.wait_for(run_task, timeout=2)
    await core.close()


async def test_no_stored_password_prompts_via_core(monkeypatch):
    """凭据库无记录：password=None 传给 open_session，现场询问由核心
    ask_password 弹窗承接（旧 CLI test_switch_target_no_stored_password_prompts
    的核心侧口径）。"""
    captured: dict = {}

    async def fake_open(target, password=None, **kw):
        captured["password"] = password
        return FakeSession()

    monkeypatch.setattr(cmod, "load_password", lambda h, u, p: None)
    monkeypatch.setattr(cmod, "open_session", fake_open)
    monkeypatch.setattr(cmod, "probe_profile", lambda s, h: _profile())
    monkeypatch.setattr(cmod, "build_agent",
                        lambda *a, **k: (None, set(), None))
    core = CliCore(_cfg(), "web01", frontend=None)
    frontend = TermFrontend(core, reader=_never_reader)
    core._frontend = frontend
    run_task = asyncio.create_task(frontend.run())
    await _wait(lambda: "password" in captured, timeout=3)
    assert captured["password"] is None
    frontend._stop.set()
    await asyncio.wait_for(run_task, timeout=2)
    await core.close()
