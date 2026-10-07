"""web worker 单测（单管线 §5）：PTY 字节直写主 xterm 是唯一显示管线，
worker 只做记账（OSC 133/6337）、AI 任务与注入通道、非显示事件。
"""
import asyncio
import json
import time
from types import SimpleNamespace

from openterminal.config import Config
from openterminal.sysprobe import SystemProfile
from openterminal.web.protocol import ClientMsg
from openterminal.web.worker import TabWorker


class FakeSink:
    def __init__(self):
        self.messages = []   # ("bytes"|"text", payload)

    async def send_bytes(self, data):
        self.messages.append(("bytes", data))

    async def send_text(self, text):
        self.messages.append(("text", text))

    def json(self):
        return [json.loads(t) for k, t in self.messages if k == "text"]


class FakeSession:
    def __init__(self):
        self.cwd = "/tmp"
        self.calls = []
        self.raw_times = []   # 与 calls 中 raw 项对齐的 monotonic 时间戳
        self._run_lock = asyncio.Lock()
        self.recover_calls = 0
        self.recover_ok = True

    async def start(self):
        pass

    async def recover(self):
        self.recover_calls += 1
        return self.recover_ok

    async def run(self, command, *, timeout=None, on_output=None):
        self.calls.append(("run", command))
        from openterminal.shell_session import CommandResult
        return CommandResult(output="hello", exit_code=0, truncated=False, cwd="/tmp")

    async def send_raw(self, data):
        self.calls.append(("raw", data))
        self.raw_times.append(time.monotonic())

    async def resize(self, rows, cols):
        self.calls.append(("resize", rows, cols))

    async def _read_some(self, idle_timeout):
        await asyncio.sleep(0.01)
        raise asyncio.TimeoutError()

    async def close(self):
        self.calls.append(("close", None))


def _profile():
    return SystemProfile(host="web01", os_family="linux", distro="Debian",
                         version="", kernel="", pkg_manager="apt",
                         service_mgr="systemd", shell="/bin/bash", tools={})


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


async def _make_worker(monkeypatch, target="web01",
                       session=None, user="root", commands=None):
    import openterminal.web.worker as wmod
    from openterminal.config import TargetConfig

    cfg = Config.load()
    cfg.targets["web01"] = TargetConfig(name="web01", mode="ssh",
                                        host="10.0.0.20", user=user)
    if commands is not None:
        cfg.targets["web01"].commands = commands
    monkeypatch.setattr(wmod, "load_password", lambda *a: None)

    sess = session if session is not None else FakeSession()

    async def _fake_open(*a, **k):
        return sess

    async def _fake_probe(s, h):
        return _profile()

    monkeypatch.setattr(wmod, "open_session", _fake_open)
    monkeypatch.setattr(wmod, "probe_profile", _fake_probe)
    monkeypatch.setattr(wmod, "build_agent",
                        lambda *a, **k: (None, set(), None))
    w = TabWorker(cfg, target)
    sink = FakeSink()
    w.attach(sink)
    return w, sink


async def _wait_json(sink, predicate, timeout=2):
    """轮询 sink 直到谓词命中某批 JSON 消息（避免 outbox 送达竞态）。"""
    async def _poll():
        while True:
            msgs = sink.json()
            if predicate(msgs):
                return msgs
            await asyncio.sleep(0.01)
    return await asyncio.wait_for(_poll(), timeout=timeout)


async def _wait(pred, timeout=2):
    """轮询任意谓词直到为真（bytes 断言用；_wait_json 只管 JSON）。"""
    async def _poll():
        while not pred():
            await asyncio.sleep(0.01)
    await asyncio.wait_for(_poll(), timeout=timeout)


def _sink_bytes(sink):
    return b"".join(d for k, d in sink.messages if k == "bytes")


def _event_kinds(sink):
    return [m["event"]["kind"] for m in sink.json()
            if m.get("type") == "event" and "kind" in m.get("event", {})]


def _events(sink, kind):
    return [m["event"] for m in sink.json()
            if m.get("type") == "event"
            and m.get("event", {}).get("kind") == kind]


# --- 连接与就绪 ---

async def test_worker_connects_and_ready(monkeypatch):
    # FakeSession 探测输出无 shell 标记 → 回退直通，ready.interactive 省略
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    msgs = await _wait_json(sink, lambda m: any(
        x["type"] == "ready" and x["host"] == "10.0.0.20" for x in m))
    ready = next(x for x in msgs if x["type"] == "ready")
    assert "interactive" not in ready     # 0 被省略：AI 不可用
    assert not w._interactive
    assert any(m["type"] == "status" and "已连接" in m.get("text", "")
               for m in sink.json())


async def test_worker_local_target_skips_probe(monkeypatch):
    # 回归（Windows Agent 模式空白）：local 目标跑 POSIX 探针在 PowerShell 下
    # 无哨兵输出 → run 挂满超时 → ready 永不到达。local 必须直接用本地画像。
    import openterminal.web.worker as wmod

    cfg = Config.load()
    monkeypatch.setattr(wmod, "load_password", lambda *a: None)

    async def _fake_open(*a, **k):
        return FakeSession()

    def _boom_probe(s, h):
        raise AssertionError("local 目标不应调用 probe_profile")

    monkeypatch.setattr(wmod, "open_session", _fake_open)
    monkeypatch.setattr(wmod, "probe_profile", _boom_probe)
    monkeypatch.setattr(wmod, "build_agent",
                        lambda *a, **k: (None, set(), None))
    w = TabWorker(cfg, "default")
    sink = FakeSink()
    w.attach(sink)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await _wait_json(sink, lambda m: any(x["type"] == "ready"
                                         and x["host"] == "local" for x in m))


async def test_worker_connect_failure_sends_closed(monkeypatch):
    # 连接失败：发 closed、sender 排空后退出（不泄漏协程）
    import openterminal.web.worker as wmod
    from openterminal.config import TargetConfig

    cfg = Config.load()
    cfg.targets["web01"] = TargetConfig(name="web01", mode="ssh",
                                        host="10.0.0.20", user="root")
    monkeypatch.setattr(wmod, "load_password", lambda *a: None)

    async def _bad(*a, **k):
        raise ConnectionError("boom")

    monkeypatch.setattr(wmod, "open_session", _bad)
    monkeypatch.setattr(wmod, "probe_profile", lambda s, h: _profile())
    monkeypatch.setattr(wmod, "build_agent",
                        lambda *a, **k: (None, set(), None))
    w = TabWorker(cfg, "web01")
    sink = FakeSink()
    w.attach(sink)

    async def _saw_closed():
        while True:
            if any(m["type"] == "closed" for m in sink.json()):
                return
            await asyncio.sleep(0.01)
    await asyncio.wait_for(_saw_closed(), timeout=2)
    await asyncio.sleep(0.05)
    assert w._closed
    assert w._sender.done()


async def test_worker_auth_remember_stores_password(monkeypatch):
    # 认证弹窗勾选「记住」→ 密码写入 keyring（与重连 load_password 同一键）
    import openterminal.web.worker as wmod

    stored = []
    monkeypatch.setattr(wmod, "store_password",
                        lambda host, user, port, pw: stored.append((host, user, port, pw)))
    w, sink = await _make_worker(monkeypatch, target="web01")
    await asyncio.wait_for(w.connected.wait(), timeout=2)

    await w.handle_client(ClientMsg(type="auth", auth_kind="password",
                                    text="sekret", remember=True))
    assert stored == [("10.0.0.20", "root", None, "sekret")]
    # 不勾选 remember：不落库
    await w.handle_client(ClientMsg(type="auth", auth_kind="password", text="x"))
    assert stored == [("10.0.0.20", "root", None, "sekret")]
    # local 目标（default）不落库
    wl, _ = await _make_worker(monkeypatch, target="default")
    await asyncio.wait_for(wl.connected.wait(), timeout=2)
    await wl.handle_client(ClientMsg(type="auth", auth_kind="password",
                                     text="pw", remember=True))
    assert stored == [("10.0.0.20", "root", None, "sekret")]


# --- 键盘 / resize / 模式（单管线：字节直发，无输入路由）---

async def test_worker_keys_and_resize_forwarded(monkeypatch):
    # 键盘字节直发 PTY；回退模型下不做任何分类/路由
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await w.handle_client(ClientMsg(type="raw", data=b"ls\r"))
    await w.handle_client(ClientMsg(type="raw", data=b"\x1b[A"))
    await w.handle_client(ClientMsg(type="resize", cols=100, rows=30))

    async def _seen():
        while ("raw", b"ls\r") not in w.session.calls \
                or ("raw", b"\x1b[A") not in w.session.calls \
                or ("resize", 30, 100) not in w.session.calls:
            await asyncio.sleep(0.01)
    await asyncio.wait_for(_seen(), timeout=2)


async def test_worker_interrupt_sends_ctrl_c(monkeypatch):
    # ⏹/Ctrl+C：字节直达 PTY（不经过排队的 _inbox）
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await w.handle_client(ClientMsg(type="interrupt"))
    await _wait(lambda: ("raw", b"\x03") in w.session.calls)


async def test_worker_mode_switch_non_interactive_noop_on_pty(monkeypatch):
    # 非集成（直通）模式：mode 只切显示标志，不发任何注入行
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    n = len(w.session.calls)
    await w.handle_client(ClientMsg(type="mode", text="ssh"))
    await _wait(lambda: w._display == "ssh")
    await w.handle_client(ClientMsg(type="mode", text="agent"))
    await _wait(lambda: w._display == "agent")
    assert len(w.session.calls) == n


async def test_worker_fallback_bytes_passthrough(monkeypatch):
    """回退模型：PTY 字节原样二进制帧转发（唯一显示管线），无事件包装。"""
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    sess.push(b"hello\x1b[31mred\x1b[0m\r\n")
    await _wait(lambda: b"hello" in _sink_bytes(sink))
    assert b"hello\x1b[31mred\x1b[0m\r\n" in _sink_bytes(sink)
    assert not any(m.get("type") == "raw_mode" for m in sink.json())


# --- 集成模式：用户命令记账 + 字节转发 ---

async def test_worker_cmd_accounting_and_forward(monkeypatch, tmp_path):
    """CMD 报告的用户命令：不进 ctx 栈，_open_cmds 记账；输出字节直通；
    exec_end 记 transcript 退出码 + 历史库（source=user）。"""
    import openterminal.history_db as history_db

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True

    w._pending_report = (1, "CMD", "ls -la /tmp")
    await w._on_exec_start(1)
    assert w._open_cmds == {1: "ls -la /tmp"}
    assert not w._exec_stack                       # 用户命令不进栈
    await w._on_exec_text("file1\nfile2\n")        # 输出直通前端
    await _wait(lambda: b"file1\nfile2\n" in _sink_bytes(sink))
    await w._on_exec_end(1, 0, "/tmp")
    assert 1 not in w._open_cmds

    got = [(r["source"], r["command"])
           for r in history_db.recent("10.0.0.20", 100)]
    assert ("user", "ls -la /tmp") in got


async def test_worker_suppressed_echo_swallowed_then_newline(monkeypatch, tmp_path):
    """注入窗口（§5.5）：live 回显字节吞掉；执行开始时补 \\r\\n 收束被吞的
    提示符行（否则命令输出接在提示符同一行）。"""
    import openterminal.history_db as history_db
    monkeypatch.setattr(history_db, "record", lambda *a, **k: None)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True

    w._suppress_live = True
    await w._on_stream_event(("live", "eval base64注入行\r\n"))
    assert _sink_bytes(sink) == b""                # 回显吞掉
    w._pending_report = (1, "CMD", "ls")
    await w._on_exec_start(1)
    await _wait(lambda: _sink_bytes(sink) == b"\r\n")   # 补换行收束
    w._suppress_live = False
    await w._on_exec_end(1, 0, "/tmp")


# --- 集成模式：AI 工具命令（agent ctx）与 ai_collapse ---

def _wire_presenter(w):
    from openterminal.web.worker import _WebPresenter

    # agent 改为惰性构建后，_run_task 仅在 self.agent is None 时才 _ensure_agent
    # （构建会重置 backend）。这里注入假 backend 前先置一个非 None 的 agent 哨兵，
    # 让任务路径跳过真构建、不覆盖注入的假 backend（同 test_worker_change_model
    # L683 的既有惯例）。
    w.agent = object()
    w.backend = SimpleNamespace(on_start=None, on_output=None, on_finish=None)
    p = _WebPresenter(w)
    w.backend.on_start = p.on_start
    w.backend.on_output = None     # 输出由 exec 状态机直写，不走回调
    w.backend.on_finish = p.on_finish
    return p


async def test_worker_agent_exec_flow_and_ai_collapse_once(monkeypatch, tmp_path):
    """AI 工具命令：EXEC 报告 + runner 持 fut → ctx=agent；输出捕获并直写
    主 xterm；ai_collapse 每任务只发首个命令（多命令并发发起时同理）。"""
    import openterminal.history_db as history_db
    monkeypatch.setattr(history_db, "record", lambda *a, **k: None)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    _wire_presenter(w)
    loop = asyncio.get_running_loop()

    for i, cmd in enumerate(("df -h", "free -h")):
        w.backend.on_start(cmd)                     # 模型登记（可并发先到）
        fut = loop.create_future()
        w._exec_future = fut
        w._suppress_live = True
        w._pending_report = (i + 1, "EXEC", "eval 注入 " + cmd)
        await w._on_exec_start(i + 1)
        assert w._exec_stack[-1]["ctx"] == "agent"
        await w._on_exec_text("out-of-" + cmd + "\n")
        await w._on_exec_end(i + 1, 0, "/tmp")
        res = await asyncio.wait_for(fut, timeout=1)
        assert res.exit_code == 0
        assert cmd in res.output
        assert w._suppress_live is False            # D 后立即恢复 live
        w._exec_future = None

    # exec_start/exec_text/exec_end 的发送全是不同步挂起的 outbox 入队，
    # 需让位事件循环等 sender 冲刷
    await _wait(lambda: len(_events(sink, "ai_collapse")) == 1)
    collapses = _events(sink, "ai_collapse")
    assert collapses[0]["command"] == "df -h"       # 首个真实执行的命令
    out = _sink_bytes(sink)
    assert b"out-of-df -h" in out and b"out-of-free -h" in out
    # 注入行回显不外显
    assert b"eval" not in out
    import openterminal.history_db as history_db
    got = [r["command"] for r in history_db.recent("10.0.0.20", 100)]
    # 历史库在 tmp 外（本测试未设 OPENTERMINAL_HOME），只验证登记路径不崩
    assert isinstance(got, list)


async def test_worker_agent_history_recorded(monkeypatch, tmp_path):
    """AI 工具命令落历史库（source=agent），用户命令落 user。"""
    import openterminal.history_db as history_db

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    _wire_presenter(w)
    loop = asyncio.get_running_loop()

    w._pending_report = (1, "CMD", "ls -la /tmp")
    await w._on_exec_start(1)
    await w._on_exec_end(1, 0, "/tmp")

    w.backend.on_start("df -h")
    fut = loop.create_future()
    w._exec_future = fut
    w._pending_report = (2, "EXEC", "df -h")
    await w._on_exec_start(2)
    await w._on_exec_end(2, 0, "/tmp")
    await fut

    got = [(r["source"], r["command"])
           for r in history_db.recent("10.0.0.20", 100)]
    assert ("user", "ls -la /tmp") in got
    assert ("agent", "df -h") in got


async def test_worker_probe_exec_hidden(monkeypatch, tmp_path):
    """ctx=probe（隐藏探测）：输出只捕获不转发、无事件、不落历史。"""
    import openterminal.history_db as history_db

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    loop = asyncio.get_running_loop()

    w._hidden_exec = True
    w._exec_buf = bytearray()
    fut = loop.create_future()
    w._exec_future = fut
    w._pending_report = (1, "EXEC", "compgen -c gi")
    await w._on_exec_start(1)
    assert w._exec_stack[-1]["ctx"] == "probe"
    await w._on_exec_text("git\n")
    await w._on_exec_end(1, 0, "/tmp")
    res = await asyncio.wait_for(fut, timeout=1)
    w._hidden_exec = False
    w._exec_future = None

    assert res.output == "git\n" and res.exit_code == 0
    assert not any(k == "bytes" and b"git" in d for k, d in sink.messages)
    assert _event_kinds(sink) == []


async def test_worker_silent_exec_swallowed(monkeypatch):
    """ctx=silent（模式开关注入）：无 fut 无 EXEC 报告 → 输出吞掉不外显。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True

    w._pending_report = (1, "EXEC", "__ot_off=1")
    await w._on_exec_start(1)
    assert w._exec_stack[-1]["ctx"] == "silent"
    await w._on_exec_text("toggle noise\r\n")
    assert _sink_bytes(sink) == b""
    await w._on_exec_end(1, 0, "/tmp")
    assert not w._exec_stack


async def test_worker_injection_lines_silent_no_blank(monkeypatch):
    """重注入分片/eval 行：静默开帧、不补收束换行。

    每片 __ot_run 的 C 标记走 _close_suppressed_line 各打一个 \\r\\n，
    正是「输入自然语言后连打空行」的来源；export 报错则走无帧 exec 直通。
    """
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True

    w._suppress_live = True
    w._suppressed_echo = True
    w._pending_report = (1, "CMD", '__ot_inj="$__ot_inj"\'b3RfcHJvbXB0\'')
    await w._on_exec_start(1)
    assert w._exec_stack[-1]["ctx"] == "silent"
    await w._on_exec_text("-bash: export: fake: not a function\n")
    assert _sink_bytes(sink) == b""          # 报错不外显
    await w._on_exec_end(1, 0, "/tmp")
    assert not w._exec_stack
    assert _sink_bytes(sink) == b""          # 也不补收束换行

    w._pending_report = (1, "CMD", 'eval "$(echo "$__ot_inj" | base64 -d)"')
    await w._on_exec_start(1)
    assert w._exec_stack[-1]["ctx"] == "silent"
    await w._on_exec_end(1, 0, "/tmp")
    assert _sink_bytes(sink) == b""


async def test_worker_orphan_exec_end_ignored(monkeypatch):
    """无栈的 D 标记（孤儿）：忽略，不崩、不误记账。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    await w._on_exec_end(9, 0, "/tmp")     # 从未开帧
    assert not w._exec_stack


# --- presenter 队列清理 ---

async def test_worker_presenter_queue_cleanup(monkeypatch):
    """并发登记的命令按真实执行顺序弹出；忙拒绝（从未执行）的命令不残留。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    _wire_presenter(w)

    w.backend.on_start("df -h")
    w.backend.on_start("free -h")
    assert list(w._pending_agent_cmds) == ["df -h", "free -h"]
    assert _event_kinds(sink) == []        # 登记不发任何事件

    w.backend.on_finish("df -h", 124)      # busy 拒绝：从未执行
    assert list(w._pending_agent_cmds) == ["free -h"]
    assert _event_kinds(sink) == []
    w.backend.on_finish("free -h", 124)
    assert list(w._pending_agent_cmds) == []


# --- AI 任务事件流 ---

class FakeRunner:
    input_tokens = 123
    output_tokens = 45
    interrupt_payload = None

    def __init__(self, agent, thread_id, *, max_tool_turns=10, on_event=None):
        self.on_event = on_event

    async def run(self, text):
        if self.on_event:
            self.on_event(SimpleNamespace(kind="think", text="推理中"))
            self.on_event(SimpleNamespace(kind="token", text="分析中"))
        return [SimpleNamespace(kind="final", text="磁盘 80%")]


async def _install_fake_runner(monkeypatch, runner_cls=FakeRunner):
    import openterminal.agent as amod
    monkeypatch.setattr(amod, "TaskRunner", runner_cls)


class FakeToolRunner(FakeRunner):
    """非 execute 工具调用：tool_start/tool_end 实时事件（工具卡通路）。"""

    def __init__(self, agent, thread_id, *, max_tool_turns=10, on_event=None):
        self.on_event = on_event

    async def run(self, text):
        if self.on_event:
            self.on_event(SimpleNamespace(kind="tool_start", text="notes.txt",
                                          name="read_file", index=1,
                                          failed=False, command=""))
            self.on_event(SimpleNamespace(kind="tool_end", text="",
                                          name="read_file", index=1,
                                          failed=False, command=""))
        return [SimpleNamespace(kind="final", text="读完了")]


class FakeEstRunner(FakeRunner):
    """网关不回传 usage_metadata：只有 tiktoken 估算量。"""
    input_tokens = 0
    output_tokens = 0
    est_input_tokens = 640
    est_output_tokens = 128


async def test_worker_task_flow_events(monkeypatch):
    """任务事件流：task_start → ai_think/ai_token → final+ai_card → usage。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)

    w._start_ai("看看磁盘占用")
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and x["event"]["text"] == "看看磁盘占用" for x in m))
    await _wait(lambda: w._ai_task is None)
    kinds = _event_kinds(sink)
    assert kinds == ["task_start", "ai_think", "ai_token", "final", "ai_card"], kinds
    final = _events(sink, "final")[0]
    card = _events(sink, "ai_card")[0]
    assert final["text"] == "磁盘 80%"
    assert card["markdown"] == "磁盘 80%"
    usage = await _wait_json(sink, lambda m: any(
        x["type"] == "usage" and x.get("tokens_in") == 123 for x in m))
    assert any(x.get("tokens_out") == 45 for x in usage)


async def test_worker_tool_card_events(monkeypatch):
    """非 execute 工具：先 ai_collapse 定格分析卡，再 ai_tool start/end
    挂工具调用小卡（end 用同 id 配对置状态徽标）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await _install_fake_runner(monkeypatch, FakeToolRunner)
    _wire_presenter(w)

    w._start_ai("读一下 notes.txt")
    await _wait(lambda: w._ai_task is None)
    kinds = _event_kinds(sink)
    assert kinds == ["task_start", "ai_collapse", "ai_tool", "ai_tool",
                     "final", "ai_card"], kinds
    tools = [x["event"] for x in sink.json()
             if x.get("event", {}).get("kind") == "ai_tool"]
    assert tools[0]["phase"] == "start"
    assert tools[0]["name"] == "read_file"
    assert tools[0]["args"] == "notes.txt"
    assert tools[0]["id"] == 1
    assert tools[1]["phase"] == "end"
    assert tools[1]["id"] == 1
    assert not tools[1].get("failed")


async def test_worker_tool_card_ids_unique_across_tasks(monkeypatch):
    """工具卡 id 全会话唯一：TaskRunner 的 index 每任务从 1 重新计数，直接
    透传会让多个任务的卡同 id——前端 slot/feed root 按 id 迁移互抢宿主
    （每帧重挂 = 闪烁）、store 堆同 id 卡、tool_end 改错卡。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await _install_fake_runner(monkeypatch, FakeToolRunner)
    _wire_presenter(w)

    w._start_ai("第一读")
    await _wait(lambda: w._ai_task is None)
    w._start_ai("第二读")
    await _wait(lambda: w._ai_task is None)
    starts = [x["event"] for x in sink.json()
              if x.get("event", {}).get("kind") == "ai_tool"
              and x["event"].get("phase") == "start"]
    assert [t["id"] for t in starts] == [1, 2], starts


async def test_worker_usage_estimated_fallback(monkeypatch):
    """网关不回传 usage：累计 tiktoken 估算量，usage 带 estimated=1。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await _install_fake_runner(monkeypatch, FakeEstRunner)
    _wire_presenter(w)

    w._start_ai("看看磁盘占用")
    await _wait(lambda: w._ai_task is None)
    usage = await _wait_json(sink, lambda m: any(
        x["type"] == "usage" and x.get("tokens_in") == 640 for x in m))
    assert any(x.get("tokens_out") == 128 for x in usage)
    assert any(x.get("estimated") for x in usage)

    # 第二个任务继续累计（估算口径逐任务叠加）
    w._start_ai("再看内存")
    await _wait(lambda: w._ai_task is None)
    usage2 = await _wait_json(sink, lambda m: any(
        x["type"] == "usage" and x.get("tokens_in") == 1280 for x in m))
    assert any(x.get("tokens_out") == 256 for x in usage2)


async def test_worker_ai_lines_queue_when_busy(monkeypatch):
    """AI 忙时的自然语言行排队，空闲后依序回放。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)

    blocker = asyncio.create_task(asyncio.Event().wait())
    w._ai_task = blocker
    await w._on_ai_line("第一句")
    await w._on_ai_line("第二句")
    assert w._ai_queue == [("第一句", False), ("第二句", False)]

    blocker.cancel()
    try:
        await blocker
    except asyncio.CancelledError:
        pass
    w._ai_task = None
    _q = w._ai_queue.pop(0)
    w._start_ai(_q[0], _q[1])             # 触发回放；后续由 finally 链式接续
    # 等收据不等账本：_ai_task/queue 清零时最后一个 task_start 可能还在
    # outbox 在途（windows CI 实录过），按 sink 收到两单才算回放完
    await _wait_json(sink, lambda msgs: sum(
        1 for m in msgs if m.get("event", {}).get("kind") == "task_start") >= 2)
    starts = [m["event"]["text"] for m in sink.json()
              if m.get("event", {}).get("kind") == "task_start"]
    assert starts == ["第一句", "第二句"]


async def test_worker_ai_line_strips_question_prefix(monkeypatch):
    """? 前缀经 hook AI 报告进来，任务文本剥掉前缀。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)

    w._start_ai("?df -h 是干嘛的")
    await _wait(lambda: w._ai_task is None)
    ts = _events(sink, "task_start")[0]
    assert ts["text"] == "df -h 是干嘛的"


async def test_worker_unknown_slash_falls_through_to_task(monkeypatch):
    """未知斜杠命令不静默吞：/clearn 打错字、无 +x 的 /x.sh 落回正常任务。

    真机症状：hook 蓝色重绘后零反馈（不执行、不进 AI、不报错），用户以为
    终端卡死。已知斜杠命令仍被 _handle_slash 消费（见 slash_clear 用例）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)

    w._start_ai("/tmp/no_such_script.sh --prod")
    await _wait(lambda: w._ai_task is None)
    ts = _events(sink, "task_start")
    assert [e["text"] for e in ts] == ["/tmp/no_such_script.sh --prod"]


async def test_worker_slash_clear_resets_transcript(monkeypatch):
    """/clear：新 transcript + 状态提示 + session_cleared 事件 + 原生 Ctrl+L 清屏。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    old = w.transcript
    await w._handle_slash("/clear")
    await _wait_json(sink, lambda m: any(
        x["type"] == "status" and "已开启新任务" in x.get("text", "")
        for x in m))
    assert w.transcript is not old
    assert ("raw", b"\x0c") in w.session.calls
    # 前端依赖此事件清掉本任务的全部 AI 卡（M2：新会话清卡）
    assert _events(sink, "session_cleared")


async def test_worker_slash_model_and_target_listing(monkeypatch):
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await w._handle_slash("/model")
    await w._handle_slash("/target")
    await _wait_json(sink, lambda m: any(
        x["type"] == "status" and "base_url" in x.get("text", "")
        or x["type"] == "status" and "可用目标" in x.get("text", "")
        for x in m))


async def test_worker_change_model(monkeypatch):
    # 运行时切换模型：重建 agent、更新 self._model、回状态消息
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w.agent = object()   # 模拟已构建 agent（绕过 None 保护）
    await w.handle_client(ClientMsg(type="change_model", model="claude-opus-4-6"))
    await _wait_json(sink, lambda m: any(
        x["type"] == "status" and "已切换模型" in x.get("text", "") for x in m))
    assert w._model.model == "claude-opus-4-6"
    # 切到相同模型是 no-op（不重发状态）
    before = len(sink.messages)
    await w.handle_client(ClientMsg(type="change_model", model="claude-opus-4-6"))
    assert len(sink.messages) == before


# --- InteractiveRunner ---

async def test_runner_timeout_force_returns_130(monkeypatch):
    # 回归：InteractiveRunner 超时发 Ctrl+C 后按 130 返回；栈/future 清理干净，
    # _wait_exec_idle 不再永久忙
    from openterminal.web.worker import InteractiveRunner

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._shell_kind = "bash"
    w._b64flag = "-d"
    runner = InteractiveRunner(w)
    res = await asyncio.wait_for(
        runner.run("sleep 100", timeout=0.3, on_output=None), timeout=5)
    assert res.exit_code == 130
    assert w._exec_future is None
    assert w._suppress_live is False
    # Ctrl+C 已发（\x15 收半行 + \x03 中断；不 yank 复活 kill ring 文本）
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert b"\x03" in raws and not any(d == b"\x19" for d in raws)
    assert await asyncio.wait_for(w._wait_exec_idle(0.1), timeout=2)


async def test_runner_sends_yank_restore_when_hook_ok(monkeypatch):
    """hook 在位：命令注入 \x15 收纳半行、执行收尾发 \x19 接回（真机「任务
    期打字只剩尾巴」根因修复）；hook 不在位（su - 重置）不发 \x19——原生 ^Y
    会复活 kill ring 旧内容。"""
    from openterminal.web.worker import InteractiveRunner

    async def _one(hook_ok: bool):
        w, sink = await _make_worker(monkeypatch)
        await asyncio.wait_for(w.connected.wait(), timeout=2)
        w._interactive = True
        w._shell_kind = "bash"
        w._b64flag = "-d"
        if hook_ok:
            w._last_mark_at = 1.0
        runner = InteractiveRunner(w)
        t = asyncio.ensure_future(
            runner.run("docker ps", timeout=5, on_output=None))
        await _wait(lambda: any(d == b"\x15"
                                for k, d in w.session.calls if k == "raw"))
        await asyncio.sleep(0.05)
        # 直接 resolve：喂 exec_start 流事件会刷新 _last_mark_at，让 hook
        # 「不在位」用例自相矛盾（C 帧标记本身就是 hook 在位的凭据）
        from openterminal.web.worker import CommandResult
        w._exec_future.set_result(CommandResult(
            output="CONTAINER ID\n", exit_code=0, truncated=False, cwd="/tmp"))
        await asyncio.wait_for(t, timeout=5)
        return [d for k, d in w.session.calls if k == "raw"]

    raws = await _one(True)
    assert raws[0] == b"\x15"
    assert raws[-1] == b"\x19", "hook 在位：注入收尾必须发 \\x19 接回半行"
    raws = await _one(False)
    assert raws[0] == b"\x15"
    assert not any(d == b"\x19" for d in raws), \
        "hook 不在位：不得发 \\x19（原生 yank 会复活 kill ring 旧内容）"


async def test_runner_busy_target_returns_124(monkeypatch):
    # 目标忙（栈未收束）：不注入，按 124 拒绝且不污染登记队列
    from openterminal.web.worker import InteractiveRunner

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._shell_kind = "bash"
    w._exec_stack = [{"ctx": "agent", "line": "x", "inst": 1}]
    runner = InteractiveRunner(w)
    res = await asyncio.wait_for(
        runner.run("df -h", timeout=0.3, on_output=None), timeout=5)
    assert res.exit_code == 124
    assert w._exec_future is None
    assert not any(d == b"\x19" for k, d in w.session.calls if k == "raw")


# --- 泵与关闭 ---

async def test_worker_close_exits_tasks(monkeypatch):
    # 外部 close：_run/_sender 应自然退出，不泄漏协程、不死锁
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await w.close()
    await asyncio.wait_for(w._task, timeout=2)
    await asyncio.sleep(0.05)
    assert w._task.done()
    assert w._sender.done()
    assert not w._pump or w._pump.done()
    # 已收到 closed 消息
    assert any(m["type"] == "closed" for m in sink.json())


async def test_worker_stop_pump_propagates_outer_cancel(monkeypatch):
    """取消吞噬回归：外层任务在 `await t`（等泵退出）上被取消时，取消会
    传导给泵任务、泵的 CancelledError 从 _stop_pump 冒出。若被吞，外层
    任务变成杀不死的僵尸——asyncio teardown 的 cancel_all gather 挂死。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await w._stop_pump()                 # 停掉真泵，换可控的假泵

    # 假泵：被 cancel 后拖 0.3s 才死（外层的第二次取消会打断休眠立即死），
    # 给外层任务留出"挂在等泵退出上被取消"的窗口
    async def eternal():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            try:
                await asyncio.sleep(0.3)
            except asyncio.CancelledError:
                pass
            raise

    w._pump = asyncio.create_task(eternal())

    outcome = {}

    async def stopper():
        try:
            await w._stop_pump()
            outcome["r"] = "returned"
        except asyncio.CancelledError:
            outcome["r"] = "cancelled"
            raise
        except BaseException as e:  # noqa: BLE001 - 测试观察用
            outcome["r"] = repr(e)

    t = asyncio.create_task(stopper())
    await asyncio.sleep(0.05)          # 让 stopper 挂在等泵任务上
    assert not t.done()
    t.cancel()
    try:
        await t
    except asyncio.CancelledError:
        pass
    assert outcome["r"] == "cancelled"   # 外层取消必须穿透，不得被吞
    assert w._pump is None               # 泵已停
    await w.close()


# --- 命令历史长期记忆（SQLite）---

async def test_worker_injects_shell_history(monkeypatch, tmp_path):
    """注入行携带 DB 里的去重命令；未知 shell 不发。"""
    import base64
    from openterminal import history_db

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    for c in ("echo one", "echo one", "echo two"):
        history_db.record("10.0.0.20", "user", c)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)

    await w._inject_shell_history("bash", "-d")
    raws = [d for k, d in w.session.calls if k == "raw"]
    inject = next(r for r in raws if b"history -r" in r)
    b64 = inject.decode().split("echo ")[1].split(" |")[0]
    assert base64.b64decode(b64).decode() == "echo one\necho two"

    before = len(w.session.calls)
    await w._inject_shell_history(None, "-d")   # 未知 shell：跳过
    assert len(w.session.calls) == before


async def test_worker_reconnect_reinjects_history(monkeypatch, tmp_path):
    """断线重连回调：用记住的 shell 种类重新灌历史。"""
    from openterminal import history_db

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    history_db.record("10.0.0.20", "user", "ls")
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._shell_kind = "bash"
    w._b64flag = "-d"
    await w._on_session_reconnect()
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert any(b"history -r" in r for r in raws)
    await w.close()


# --- 断线后敲键自动重连（_pump_eof → _on_keys → _revive_session）---

async def test_worker_keys_revive_dead_session(monkeypatch):
    """泵 EOF 置死亡标记后，首个键触发会话恢复 + 泵补启 + reconnected 通知，
    按键送往恢复后的会话。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    pump_dead = w._pump
    pump_dead.cancel()   # 模拟真实断线：泵循环先于 _pump_eof 返回
    try:
        await pump_dead
    except asyncio.CancelledError:
        pass
    await w._pump_eof("连接已断开")
    assert w._session_dead

    await w._on_keys(b"ls")
    assert w.session.recover_calls == 1
    assert not w._session_dead
    assert w._pump is not pump_dead and not w._pump.done()
    assert ("raw", b"ls") in w.session.calls
    msgs = await _wait_json(sink, lambda m: any(x.get("type") == "reconnected"
                                                for x in m))
    assert "已重新连接" in next(x["text"] for x in msgs
                                if x.get("type") == "reconnected")
    await w.close()


async def test_worker_keys_revive_failure_keeps_dead(monkeypatch):
    """恢复失败：状态栏提示重试、按键丢弃、死亡标记保留（下个键再试）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w.session.recover_ok = False
    await w._pump_eof("连接已断开")

    await w._on_keys(b"ls")
    assert w.session.recover_calls == 1
    assert w._session_dead
    assert ("raw", b"ls") not in w.session.calls
    await _wait_json(sink, lambda m: any(
        "重连失败" in x.get("text", "") for x in m))
    await w.close()


async def test_worker_no_revive_when_alive(monkeypatch):
    """会话健康时敲键不触发恢复（死亡标记是唯一开关）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await w._on_keys(b"echo hi")
    assert w.session.recover_calls == 0
    await w.close()


# --- 外部触发链 submit：健康路径（Workbench 蓝色回显）与降级路径 ---

async def _drain_fallback(w):
    """取消未触发的 _submit_fallback，避免测试退出后悬空任务告警。"""
    t = w._fallback_task
    if t is not None and not t.done():
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass


def _skip_reintegrate(w, monkeypatch):
    """submit 链路测试不关心 _ensure_integrated 的重注入（FakeSession 无
    OSC:D 回执，会空等 2s）：替身直接返回已集成。"""

    async def _noop():
        return True
    monkeypatch.setattr(w, "_ensure_integrated", _noop)


async def test_worker_submit_healthy_routes_through_hook(monkeypatch):
    """hook 在位 + 镜像可信：补发 \\r 交给 hook 蓝色重绘 + AI 上报触发；
    不发 \\x03、不直接启动任务。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0          # 本会话见过标记 → hook 在位
    w._last_live_at = 2.0          # 按键回显新于标记：不得误判绝迹（真机重复回显根因）

    await w.handle_client(ClientMsg(type="submit", text="帮我查询系统资源"))
    assert ("raw", b"\r") in w.session.calls
    assert not any(d == b"\x03" for k, d in w.session.calls if k == "raw")
    assert w._hook_report_pending == "帮我查询系统资源"
    assert w._ai_task is None      # 等 hook 上报才启动
    await _drain_fallback(w)


async def test_worker_submit_ai_report_starts_task(monkeypatch):
    """健康路径闭环：hook 的 6337 AI 上报清 pending 并启动任务（上报即启动）。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    await w.handle_client(ClientMsg(type="submit", text="帮我查询系统资源"))
    await w._on_stream_event(("report", 1, "AI", "帮我查询系统资源"))
    assert w._hook_report_pending is None
    await asyncio.wait_for(w._ai_task, timeout=2)
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and x["event"]["text"] == "帮我查询系统资源" for x in m))
    await _drain_fallback(w)


async def test_worker_submit_cmd_report_cancels_fallback(monkeypatch):
    """hook 把 submit 行分类成命令（CMD 上报）并就地执行时，兜底必须撤销：
    清 _hook_report_pending，1.2s 后不再 \x03 + 重注入 + 强起 AI 任务
    （真机：含 "=" 的自然语言被 hook 误判成命令执行，随后兜底又跑一遍 AI）。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    await w.handle_client(ClientMsg(type="submit", text="帮我查询系统资源"))
    assert w._hook_report_pending == "帮我查询系统资源"
    await w._on_stream_event(("report", 1, "CMD", "帮我查询系统资源"))
    assert w._hook_report_pending is None
    await _drain_fallback(w)
    assert w._ai_task is None      # CMD 上报即兜底撤销，不起 AI 任务


# --- 失败救援（reactive）：用户命令非零退出 → 救援卡 → 决策 ---

async def _run_failed_user_cmd(w, line, ec, output="boom: command not found"):
    """模拟 hook 在位的用户命令完整帧：CMD 上报 → C → 输出 → D(ec)。"""
    await w._on_stream_event(("report", 1, "CMD", line))
    await w._on_stream_event(("exec_start", 1))
    await w._on_stream_event(("exec", output))
    await w._on_stream_event(("exec_end", 1, ec, "/root"))


async def test_worker_rescue_on_failed_user_command(monkeypatch):
    """用户命令非零退出 → 挂救援卡事件（带失败行/退出码/输出尾部）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True

    await _run_failed_user_cmd(w, "帮我把ll=ls -al设置永久", 127,
                               "-bash: 帮我把ll=ls: command not found\r\n")
    await _wait_json(sink, lambda m: bool(_events(sink, "rescue")))
    ev = _events(sink, "rescue")[0]
    assert ev["line"] == "帮我把ll=ls -al设置永久"
    assert ev["ec"] == 127
    assert "command not found" in ev["output"]
    assert w._rescue_open
    assert w._ai_task is None       # 救援是手动卡，不自动起任务


async def test_worker_rescue_skipped_on_success_or_interrupt(monkeypatch):
    """退出码 0（成功）与 130/143（用户 Ctrl+C/kill）不是失败，不挂卡。
    「正常失败」（grep 无匹配 exit 1 等）仍挂卡——卡是手动的、可忽略，
    只是不自动劫持进 AI。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True

    await _run_failed_user_cmd(w, "ls /root", 0)
    await _run_failed_user_cmd(w, "top", 130, "^C")
    await _run_failed_user_cmd(w, "top", 143)
    await asyncio.sleep(0.05)
    assert _events(sink, "rescue") == []
    assert not w._rescue_open


async def test_worker_rescue_suppressed_while_ai_running(monkeypatch):
    """AI 任务在跑时用户命令失败不掺和：不挂卡。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._ai_task = asyncio.ensure_future(asyncio.sleep(10))

    await _run_failed_user_cmd(w, "typo-cmd", 127)
    await asyncio.sleep(0.05)
    assert _events(sink, "rescue") == []
    assert not w._rescue_open
    w._ai_task.cancel()


async def test_worker_rescue_accept_starts_ai_task(monkeypatch):
    """救援卡「交给 AI」：以失败上下文组 prompt 起任务（自然语言优先解读）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    await _run_failed_user_cmd(w, "帮我把ll=ls -al设置永久", 127,
                               "-bash: 帮我把ll=ls: command not found")
    await _wait_json(sink, lambda m: bool(_events(sink, "rescue")))

    await w.handle_client(ClientMsg(type="rescue", accept=True))
    assert not w._rescue_open
    await asyncio.wait_for(w._ai_task, timeout=2)
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and "帮我把ll=ls -al设置永久" in x["event"]["text"]
        and "command not found" in x["event"]["text"] for x in m))


async def test_worker_rescue_reject_no_task(monkeypatch):
    """救援卡「忽略」：清卡不起任务。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    await _run_failed_user_cmd(w, "gti status", 127, "gti: command not found")
    await _wait_json(sink, lambda m: bool(_events(sink, "rescue")))

    await w.handle_client(ClientMsg(type="rescue", accept=False))
    assert not w._rescue_open
    assert w._rescue_ctx is None
    await asyncio.sleep(0.05)
    assert w._ai_task is None


async def test_worker_submit_dirty_hook_alive_routes_through_hook(monkeypatch):
    """dirty（镜像被无法镜像的转义/控制键清过，如历史召回）+ hook 在位：
    shell BUFFER 即真相——同样补发 \\r 交 hook 原地蓝色重绘真行并上报触发；
    不 \\x03 丢弃真行、也不拿残镜像挂兜底（残镜像与上报必不相等，兜底会在
    1.2s 后按残行误起任务）。真机：「帮我把ll设置为"ls -al"的别名」行内方向
    键编辑，旧实现镜像只剩光标后尾巴并走降级重发，AI 收到残句。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)

    n = len([c for c in w.session.calls if c[0] == "raw"])
    await w.handle_client(ClientMsg(type="submit", text="的别名", dirty=True))
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert raws == [b"\r"], "hook 在位只补发回车，真行交给 hook 上报"
    assert w._hook_report_pending is None, "镜像不可信不挂兜底等待"
    assert w._fallback_task is None
    assert w._ai_task is None      # 等 hook 真行上报才启动
    real = '帮我把ll设置为"ls -al"的别名'
    await w._on_stream_event(("report", 1, "AI", real))
    assert w._hook_report_pending is None
    await asyncio.wait_for(w._ai_task, timeout=2)
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and x["event"]["text"] == real for x in m))
    await _drain_fallback(w)


async def test_worker_submit_dirty_hook_dead_silent_start(monkeypatch):
    """hook 不在位 + 镜像 dirty：\\x03 清残行 + 重注入后不把残镜像当整行重发
    （尾巴会被画屏并送 AI，真机截图根因）——按镜像文本静默外部启动任务。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 0.0          # 本会话没见过标记 = hook 不在位
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    n = len([c for c in w.session.calls if c[0] == "raw"])
    await w.handle_client(ClientMsg(type="submit", text="的别名", dirty=True))
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert b"\x03" in raws
    assert "的别名\r".encode() not in raws, "残镜像不得当整行重发"
    assert w._hook_report_pending is None
    await asyncio.wait_for(w._ai_task, timeout=2)
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and x["event"]["text"] == "的别名" for x in m))
    await _drain_fallback(w)


async def test_worker_submit_hook_dead_reintegrates_and_echoes(monkeypatch):
    """本会话无 hook 标记上报（注入失败 / 裸 shell）：\\x03 清残行 → 重注入集成脚本 → 整行重发
    走 hook 蓝色回显 + 上报触发；不再静默吞掉用户输入（真机反馈 bug）。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 0.0          # 本会话没见过标记 = hook 不在位
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    n = len([c for c in w.session.calls if c[0] == "raw"])
    await w.handle_client(ClientMsg(type="submit", text="帮我查询系统资源"))
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert b"\x03" in raws
    assert "帮我查询系统资源\r".encode() in raws
    assert w._hook_report_pending == "帮我查询系统资源"
    await w._on_stream_event(("report", 1, "AI", "帮我查询系统资源"))
    await asyncio.wait_for(w._ai_task, timeout=2)
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start" for x in m))
    await _drain_fallback(w)


async def test_worker_submit_open_user_cmd_takes_degraded_path(monkeypatch):
    """用户命令执行帧开着（前台占用，典型 sudo su - 整段会话——其 C 帧不闭合
    进入后 hook 标记亦绝迹）：readline 不在读行，健康
    路径补发的 \\r 只落进命令 stdin、hook 永不重绘/上报（真机自然语言被裸 shell
    当命令执行 command not found 的根因）——必须走降级：\\x03 + 重注入 + 整行重发。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 2.0          # hook 在位（见过标记）
    w._open_cmds[1] = "sudo su -"  # 但用户命令帧开着（C 帧未闭合）→ 必须降级
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    n = len([c for c in w.session.calls if c[0] == "raw"])
    await w.handle_client(ClientMsg(type="submit", text="看看磁盘用量"))
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert b"\x03" in raws, "帧开着不走健康路径：先清残行"
    assert "看看磁盘用量\r".encode() in raws, "重注入后整行重发取蓝色回显"
    assert w._hook_report_pending == "看看磁盘用量"
    await _drain_fallback(w)


async def test_worker_degraded_settles_after_intr(monkeypatch):
    """\\x03 与后续写入之间必须 settle：readline 的 SIGINT 恢复窗口丢弃期间
    到达的输入（真机实测紧贴 ^C 发分片丢 chunk0 头部，解码脚本缺字节、注释行
    断成命令报 command not found）。settle 期间 ^C 回显/退格重画也要吞掉。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 2.0
    w._open_cmds[1] = "sudo su -"
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    await w.handle_client(ClientMsg(type="submit", text="看看磁盘用量"))
    raws = [(i, d) for i, (k, d) in enumerate(w.session.calls) if k == "raw"]
    idx3 = [p for p, (_i, d) in enumerate(raws) if d == b"\x03"]
    assert idx3, "降级先 \x03"
    p = idx3[-1]
    assert p + 1 < len(raws), "^C 后仍有写入（重注入/重发）"
    gap = w.session.raw_times[p + 1] - w.session.raw_times[p]
    assert gap >= 0.35, f"settle 不足（{gap:.2f}s）：分片会落进 SIGINT 恢复窗口"
    await _drain_fallback(w)


async def test_worker_exec_text_swallowed_in_injection_window(monkeypatch):
    """su - 后重注入落在 EXEC 相位（C 帧未闭）：分片回显/eval 杂行走 exec 事件
    直通主屏 = base64 墙。抑制窗口内用户帧 exec 字节一并吞掉。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._suppress_live = True
    await w._on_exec_text("__ot_inj=\"$__ot_inj\"'5a+5562W'")
    await asyncio.sleep(0.02)
    assert not [m for m in sink.messages if m[0] == "bytes"], "窗口内 exec 直漏主屏"
    w._suppress_live = False
    await w._on_exec_text("root")
    await asyncio.sleep(0.02)
    assert ("bytes", b"root") in sink.messages, "窗口外用户输出照常直通"


async def test_worker_submit_hook_dead_reintegrate_fails_silent_start(monkeypatch):
    """重注入失败（老 shell / 2s 无标记回执）：退回静默启动（无回显），
    任务不悬空——与既有失联行为一致。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 0.0          # hook 不在位：走降级且重注入失败
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)

    async def _fail():
        return False
    monkeypatch.setattr(w, "_ensure_integrated", _fail)

    n = len([c for c in w.session.calls if c[0] == "raw"])
    await w.handle_client(ClientMsg(type="submit", text="帮我查询系统资源"))
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert b"\x03" in raws
    assert "帮我查询系统资源\r".encode() not in raws, "重注入失败不得重发行"
    await _wait(lambda: w._ai_task is None)
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and x["event"]["text"] == "帮我查询系统资源" for x in m))


async def test_worker_submit_fallback_fires_when_report_lost(monkeypatch):
    """补 \\r 后 hook 上报迟迟未到 → 兜底 \\x03 + 外部启动；迟到的同文
    上报被 _suppress_ai_report 吞掉，不双跑。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 0.05)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    await w.handle_client(ClientMsg(type="submit", text="帮我查询系统资源"))
    await _wait(lambda: ("raw", b"\x03") in w.session.calls)
    assert w._hook_report_pending is None
    assert w._suppress_ai_report == "帮我查询系统资源"
    await _wait(lambda: w._ai_task is None)

    # 迟到的重复上报：吞掉，不再启动第二个任务
    await w._on_stream_event(("report", 1, "AI", "帮我查询系统资源"))
    await asyncio.sleep(0.05)
    assert w._suppress_ai_report is None
    starts = await _wait_json(sink, lambda m: sum(
        1 for x in m if x.get("event", {}).get("kind") == "task_start") >= 1)
    assert len([m for m in starts
                if m.get("event", {}).get("kind") == "task_start"]) == 1


async def test_worker_submit_non_ai_passthrough(monkeypatch):
    """非自然语言（命令行）/空行/exec 忙：只透传 \\r，不拦不启动。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0

    await w.handle_client(ClientMsg(type="submit", text="ls -la /tmp"))
    await w.handle_client(ClientMsg(type="submit", text="   "))
    loop = asyncio.get_running_loop()
    w._exec_future = loop.create_future()
    await w.handle_client(ClientMsg(type="submit", text="帮我查询系统资源"))
    w._exec_future = None
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert raws == [b"\r", b"\r", b"\r"]
    assert w._hook_report_pending is None
    assert w._ai_task is None


# --- pad 打孔协议：卡片占位行必须经 shell hook 打进输出流 ---


def _wire_pad_prompt(w):
    """替身 send_raw：看到 __ot_pad 注入行即模拟 hook 打完空行后的提示符重画。"""
    sess = w.session
    base = sess.send_raw

    async def _raw(data):
        await base(data)
        if b"__ot_pad" in data:
            w._ev_prompt.set()
    sess.send_raw = _raw


async def _padded_rows(sink):
    msgs = await _wait_json(sink, lambda m: any(
        x.get("type") == "event" and x.get("event", {}).get("kind") == "padded"
        for x in m))
    return [m["event"]["rows"] for m in msgs
            if m.get("type") == "event" and m["event"].get("kind") == "padded"]


async def test_shell_pad_sends_bracketed_injection_and_acks_once(monkeypatch):
    r"""pad：\x15…__ot_pad N\r…\x19 注入（与 InteractiveRunner 共用
    _runner_lock 的半行收纳，hook 在位走 shell 侧存档/接回原语），等提示符
    重画后一次 padded 应答。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0        # 本会话见过标记 → hook 在位
    _wire_pad_prompt(w)

    await w.handle_client(ClientMsg(type="pad", pad=5))
    if w._pad_task is not None:  # pad 已挂任务：等打字完再验（非交互不挂）
        await asyncio.wait_for(w._pad_task, timeout=2)
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert raws == [b"\x15", b"__ot_pad 5\r", b"\x19"]
    assert await _padded_rows(sink) == [5]


async def test_shell_pad_chunks_over_50(monkeypatch):
    """单块上限 50（hook seq 上限）：超高分块循环打满，一次 padded 汇总应答。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0        # 本会话见过标记 → hook 在位
    _wire_pad_prompt(w)

    await w.handle_client(ClientMsg(type="pad", pad=120))
    if w._pad_task is not None:  # pad 已挂任务：等打字完再验（非交互不挂）
        await asyncio.wait_for(w._pad_task, timeout=2)
    pad_lines = [d for k, d in w.session.calls
                 if k == "raw" and b"__ot_pad" in d]
    assert pad_lines == [b"__ot_pad 50\r", b"__ot_pad 50\r", b"__ot_pad 20\r"]
    assert await _padded_rows(sink) == [120]


async def test_shell_pad_hook_gone_sends_nothing_acks(monkeypatch):
    r"""hook 不在位（su - 换壳探测失败等）：pad 零 PTY 写入仍应答 padded。

    没有 __ot_pad 通道，旧降级往提示符敲 ``__ot_pad N`` 只会连环 command
    not found + 提示符连排，前置 \x15 还连环吞用户输入（真机「打字不显示」
    根因之一）。宁藏不盖：不垫空行，卡由显隐/夹紧逻辑兜底。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._hook_gone = True          # su - 换壳：探测判定不可集成

    await w.handle_client(ClientMsg(type="pad", pad=5, mirror="rm -rf /tmp/x"))
    if w._pad_task is not None:
        await asyncio.wait_for(w._pad_task, timeout=2)
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert raws == [], "hook 不在位：不发 \\x15/__ot_pad/mirror 任何字节"
    assert await _padded_rows(sink) == [5]


async def test_shell_pad_hook_ok_uses_saved_yank_primitive(monkeypatch):
    r"""hook 在位：pad 半行保护走 shell 侧存档/接回原语（^U 存档、^Y 接回，
    空行零副作用、任务期打字与注入交错也能接回）——每块 \x15 配一 \x19，
    不再依赖前端 mirror 原样重打。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0        # 本会话见过标记 → hook 在位
    _wire_pad_prompt(w)

    await w.handle_client(ClientMsg(type="pad", pad=5, mirror="rm -rf /tmp/x"))
    if w._pad_task is not None:
        await asyncio.wait_for(w._pad_task, timeout=2)
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert raws == [b"\x15", b"__ot_pad 5\r", b"\x19"], \
        "hook 在位：\\x15 + pad + \\x19 配对，不走 mirror 重打"
    assert await _padded_rows(sink) == [5]


async def test_shell_pad_prompt_timeout_still_acks(monkeypatch):
    """hook 在位但无响应（超时容忍）也照常应答 padded——应答不作为凭据，
    前端按缓冲实测记账。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0        # hook 在位（否则走零写入早退）
    w._pad_prompt_timeout = 0.01   # 默认 FakeSession.send_raw 不置 _ev_prompt

    await w.handle_client(ClientMsg(type="pad", pad=5))
    if w._pad_task is not None:  # pad 已挂任务：等打字完再验（非交互不挂）
        await asyncio.wait_for(w._pad_task, timeout=2)
    assert await _padded_rows(sink) == [5]


async def test_pad_requires_interactive(monkeypatch):
    """非交互模式（无 hook）：pad 请求直接忽略，不应答 padded。"""
    w, sink = await _make_worker(monkeypatch)
    w._interactive = False

    await w.handle_client(ClientMsg(type="pad", pad=5))
    if w._pad_task is not None:  # pad 已挂任务：等打字完再验（非交互不挂）
        await asyncio.wait_for(w._pad_task, timeout=2)
    await asyncio.sleep(0.05)
    assert not any(m.get("type") == "event"
                   and m.get("event", {}).get("kind") == "padded"
                   for m in sink.json())


# --- su - 换壳探测：外层 shell 的脚本不能打进嵌套 shell（真机「打字不显示」）---


async def test_probe_shell_kind_parses_probe_output(monkeypatch):
    """探测行输出经 _probe_buf 收集并按 parse_probe 解析：bash5 → ("bash",
    flag)、zsh → zsh；输出含探测行回显也不影响（PROBE_TAG 定位）。"""
    import openterminal.web.worker as wmod
    for out, want in [
        ("__OTPROBE__bash5.1.8(1)-release|-d", ("bash", "-d")),
        ("__OTPROBE__zsh5.9|-D", ("zsh", "-D")),
    ]:
        w, sink = await _make_worker(monkeypatch)
        await asyncio.wait_for(w.connected.wait(), timeout=2)
        w.profile.os_family = "linux"
        base = w.session.send_raw

        async def _send(data, _base=base):
            await _base(data)
            # 探测行回显 + 执行输出一起喂（真实流里回显在前）
            await w._on_stream_event(("exec", data.decode()[:40]))
            await w._on_stream_event(("exec", out + "\r\n"))

        w.session.send_raw = _send
        got = await w._probe_shell_kind()
        assert got == want, out
        assert w._probe_buf is None, "探测结束必须清 _probe_buf"


async def test_probe_shell_kind_timeout_returns_none(monkeypatch):
    """探测行被前台占用吃掉（无输出）：超时 → (None, "-d")。"""
    import openterminal.web.worker as wmod
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    monkeypatch.setattr(wmod, "_PROBE_TIMEOUT", 0.05)
    shell, flag = await w._probe_shell_kind()
    assert (shell, flag) == (None, "-d")


async def test_ensure_integrated_foreign_shell_no_inject(monkeypatch):
    """su - 换壳（探测不到可集成 shell）：不注入、置 _hook_gone、返回 False；
    _hook_ok 随之转假。不发 \x03 之外的注入分片/__ot_pad。"""
    import openterminal.web.worker as wmod
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._shell_kind = "zsh"
    monkeypatch.setattr(wmod, "_PROBE_TIMEOUT", 0.05)

    ok = await w._ensure_integrated()
    assert ok is False
    assert w._hook_gone is True
    assert not w._hook_ok(), "标记流不足以证明 hook 在位（外族 PS1 也发标记）"
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert not any(b"__ot_inj" in d for d in raws), "外族 shell 不注入脚本"
    assert not any(b"__ot_pad" in d for d in raws)
    # 探测行还是要发的（\x15 收纳 + 探测行本身）
    assert any(b"__OTPROBE__" in d for d in raws)


async def test_ensure_integrated_reinjects_matching_shell(monkeypatch):
    """su - 换壳成 bash 5（Linux root 场景）：探测成功 → 按 bash 注入并更新
    _shell_kind/_b64flag，_hook_gone 复位，提示符标记到达后返回 True。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._shell_kind = "zsh"
    w._b64flag = "-D"

    async def _fake_probe():
        return "bash", "-d"
    monkeypatch.setattr(w, "_probe_shell_kind", _fake_probe)
    base = w.session.send_raw

    async def _raw(data):
        await base(data)
        if b"__ot_inj" in data:
            w._ev_prompt.set()   # 模拟注入落地后的提示符重画
    w.session.send_raw = _raw

    ok = await w._ensure_integrated()
    assert ok is True
    assert (w._shell_kind, w._b64flag) == ("bash", "-d")
    assert w._hook_gone is False
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert any(b"__ot_inj" in d for d in raws)


async def test_hook_gone_clears_when_nested_shell_exits(monkeypatch):
    """嵌套 shell（su -）退出、_open_cmds 清空：_hook_gone 复位，外层
    hook 的标记/函数从未丢过，健康路径恢复。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._open_cmds[7] = "sudo su -"
    w._hook_gone = True
    assert not w._hook_ok()

    await w._on_exec_end(7, 0, "/tmp")
    assert w._hook_gone is False
    assert w._hook_ok()
    # 嵌套 shell 未退出（还有别的命令帧开着）不复位
    w._hook_gone = True
    w._open_cmds[8] = "sudo su -"
    w._open_cmds[9] = "echo hi"
    await w._on_exec_end(9, 0, "/tmp")
    assert w._hook_gone is True
    await w._on_exec_end(8, 0, "/tmp")
    assert w._hook_gone is False


async def test_hooked_flag_threads_through_start_ai(monkeypatch):
    """hook 上报触发的任务带 hooked=True 一路传到 _ai_flow：_run_task 据此跳过
    重注入（注入吞窗口吃在途蓝色重绘字节＝真机「提交行消失」根因）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    seen = []

    async def fake_flow(line, hooked=False):
        seen.append((line, hooked))

    w._ai_flow = fake_flow
    w._start_ai("甲", True)
    await asyncio.sleep(0)
    assert seen == [("甲", True)]
    w._ai_task = None
    w._start_ai("乙")
    await asyncio.sleep(0)
    assert seen[-1] == ("乙", False)


# --- 连接后命令集 ---


def _cmdset_msgs(sink):
    return [m for m in sink.json() if m.get("type") == "cmdset"]


async def test_cmdset_serial_order_and_events(monkeypatch):
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    # 两条命令都不喂回显 → 走 echo 超时 + 静默即过的快路径,断言顺序
    w, sink = await _make_worker(monkeypatch, commands=["echo one", "echo two"])
    await _wait(lambda: any(m.get("state") == "done" for m in _cmdset_msgs(sink)))
    raws = [c for c in w.session.calls if c[0] == "raw"]
    assert raws[:2] == [("raw", b"echo one\r"), ("raw", b"echo two\r")]
    running = [m for m in _cmdset_msgs(sink) if m.get("state") == "running"]
    assert running[0]["index"] == 1 and running[0]["total"] == 2
    assert running[-1]["index"] == 2


async def test_cmdset_answer_on_password_prompt(monkeypatch):
    import openterminal.cmdset as cmod
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 2.0)
    monkeypatch.setattr(cmod, "load_password",
                        lambda k, u, p: "s3cret" if k == "cmdset:db01" else None)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh root@db01", "> @db01"])
    # 慢网络:提示晚到——先只喂回显,静默窗口过后再喂密码提示,仍须应答
    await asyncio.sleep(0.02)
    sess.push(b"ssh root@db01\r\n")
    await asyncio.sleep(0.15)
    sess.push(b"root@db01's password: ")
    await _wait(lambda: ("raw", b"s3cret\r") in sess.calls, timeout=5)
    msgs = await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "done" for x in m))


async def test_cmdset_answer_first_time_asks_and_remembers(monkeypatch):
    import openterminal.cmdset as cmod
    import openterminal.web.worker as wmod
    from openterminal.web.protocol import ClientMsg
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 2.0)
    monkeypatch.setattr(cmod, "load_password", lambda k, u, p: None)  # 密钥库没有
    stored = {}
    monkeypatch.setattr(wmod, "store_password",
                        lambda k, u, p, pw: stored.__setitem__(k, pw) or True)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh db01", "> @db01"])
    # 密钥库缺失 → 弹窗询问(带 cmdset 类别)
    msgs = await _wait_json(sink, lambda m: any(
        x.get("type") == "ask_password" and x.get("auth_kind") == "cmdset"
        for x in m))
    # 模拟用户在弹窗输入(经 auth cmdset 分支回填)
    await w.handle_client(ClientMsg(type="auth", auth_kind="cmdset",
                                    text="typed-pw"))
    await _wait(lambda: stored.get("cmdset:db01") == "typed-pw", timeout=2)
    # 提示出现后,本次会话用刚输入的密码自动应答
    await asyncio.sleep(0.05)
    sess.push(b"db01's password: ")
    await _wait(lambda: ("raw", b"typed-pw\r") in sess.calls, timeout=5)


async def test_cmdset_answer_empty_submit_skips(monkeypatch):
    import openterminal.cmdset as cmod
    import openterminal.web.worker as wmod
    from openterminal.web.protocol import ClientMsg
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 0.3)
    monkeypatch.setattr(cmod, "load_password", lambda k, u, p: None)
    w, sink = await _make_worker(
        monkeypatch, commands=["ssh db01", "> @nope", "echo ok"])
    await _wait_json(sink, lambda m: any(
        x.get("type") == "ask_password" for x in m))
    await w.handle_client(ClientMsg(type="auth", auth_kind="cmdset", text=""))
    msgs = await _wait_json(sink, lambda m: any(
        "已跳过自动应答" in x.get("text", "") for x in m))
    # 空提交:跳过该应答行,后续命令照常执行
    await _wait(lambda: ("raw", b"echo ok\r") in w.session.calls)


async def test_cmdset_answer_prompt_timeout_skips(monkeypatch):
    import openterminal.cmdset as cmod
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 0.2)
    monkeypatch.setattr(cmod, "load_password",
                        lambda k, u, p: "s3cret" if k == "cmdset:db01" else None)
    w, sink = await _make_worker(monkeypatch, commands=["ssh db01", "> @db01"])
    msgs = await _wait_json(sink, lambda m: any(
        "未检测到交互提示" in x.get("text", "") for x in m))
    await _wait(lambda: any(m.get("state") == "done" for m in _cmdset_msgs(sink)))
    # 明文/引用都不该被盲目发出
    assert not any(c[1] == b"s3cret\r" for c in w.session.calls if c[0] == "raw")


async def test_cmdset_comments_and_blank_skipped(monkeypatch):
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    w, sink = await _make_worker(
        monkeypatch, commands=["# 注释", "", "echo real"])
    await _wait(lambda: any(m.get("state") == "done" for m in _cmdset_msgs(sink)))
    raws = [c for c in w.session.calls if c[0] == "raw"]
    assert raws == [("raw", b"echo real\r")]
    assert _cmdset_msgs(sink)[0]["total"] == 1


async def test_cmdset_answer_prompt_with_echo_fast_network(monkeypatch):
    # 快网络:密码提示随命令回显同批到达(命令阶段内)——不得因缓冲重置
    # 而丢弃,应答仍须发出(C1:旧实现在命令阶段结束清空 tail)
    import openterminal.cmdset as cmod
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.5)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 1.0)
    monkeypatch.setattr(cmod, "load_password",
                        lambda k, u, p: "s3cret" if k == "cmdset:db01" else None)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh db01", "> @db01"])
    await asyncio.sleep(0.05)          # runner 已进入命令行阶段、开始等回显
    sess.push(b"ssh db01\r\npassword: ")   # 回显与提示同批到达
    await _wait(lambda: ("raw", b"s3cret\r") in sess.calls, timeout=3)
    msgs = await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "done" for x in m))


async def test_cmdset_reconnect_cancels_previous_runner(monkeypatch):
    # 重连时必须先取消在跑的旧 runner:否则双 runner 交错写 PTY、抢 _pws 队列
    import openterminal.web.worker as wmod
    w, sink = await _make_worker(monkeypatch)   # 无 commands:不自动启动
    w._target = SimpleNamespace(commands=["echo x"])
    w._shell_kind = None        # 历史注入跳过(种类未知)
    w._b64flag = "-d"
    old = asyncio.create_task(w._run_command_set())
    w._cs_task = old
    await w._on_session_reconnect()
    await asyncio.sleep(0.05)
    assert old.cancelled(), "旧 runner 未被取消(默认 2s 回显窗内必未自然结束)"


async def test_cmdset_pause_on_unanswered_prompt_resumes_after_input(monkeypatch):
    # 无应答行 + 终端停在密码提示 → 暂停等用户;提示消失且静默后自动继续
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.3)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.02)
    monkeypatch.setattr(wmod, "CMDSET_RESUME_QUIET", 0.3)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["sudo su -", "cd /tmp"])
    await asyncio.sleep(0.05)
    sess.push(b"sudo su -\r\n[sudo] password for xiaojian: ")
    # 暂停事件出现,且 cd /tmp 不被抢跑塞进密码提示
    msgs = await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "paused" for x in m),
        timeout=3)
    await asyncio.sleep(0.2)
    assert ("raw", b"cd /tmp\r") not in sess.calls
    # 模拟用户在终端输完密码(sudo 通过,提示消失,回到 root 提示符)
    sess.push(b"\r\n[root@VM-0-11-centos ~]# ")
    await _wait(lambda: ("raw", b"cd /tmp\r") in sess.calls, timeout=5)


async def test_cmdset_resume_button_forces_continue(monkeypatch):
    # 「继续」按钮(cmdset_resume)在提示仍在时也能强制放行
    import openterminal.web.worker as wmod
    from openterminal.web.protocol import ClientMsg
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.3)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.02)
    monkeypatch.setattr(wmod, "CMDSET_RESUME_QUIET", 5.0)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["sudo su -", "cd /tmp"])
    await asyncio.sleep(0.05)
    sess.push(b"sudo su -\r\n[sudo] password for xiaojian: ")
    await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "paused" for x in m),
        timeout=3)
    await w.handle_client(ClientMsg(type="cmdset_resume"))
    await _wait(lambda: ("raw", b"cd /tmp\r") in sess.calls, timeout=3)


async def test_switch_display_reinforces_integration_before_toggle(monkeypatch):
    # su -/嵌套 shell 会丢 hook 集成:切 Shell 模式前必须先补注入,
    # 否则 toggle 的 __ot_exec__ 变普通命令(command not found),
    # 确认标记永不回来 → 死等 5s 才清屏(真机「切 Shell 没反应」根因)
    import openterminal.web.worker as wmod

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True   # FakeSession 探测不出集成,直接置交互态走切换路径
    w._shell_kind = "bash"
    w._b64flag = "-d"

    called = []

    async def _fake_ensure():
        called.append(True)
        return True

    w._ensure_integrated = _fake_ensure
    await w._switch_display("ssh")
    assert called, "切换前未补注入集成脚本"
    assert w._display == "ssh"
    assert any(c[0] == "raw" and b"__ot_off=1" in c[1]
               for c in w.session.calls), "未发送 hook off 开关"


async def test_cmdset_secret_answer_skips_confirm_prompt(monkeypatch):
    # @引用(密码)不得应答 yes/no 类确认提示:那类提示回显输入,密码会
    # 明文漏进终端(真机:跳转时 host key 确认先弹,密码被打进该提示)
    import openterminal.cmdset as cmod
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 2.0)
    monkeypatch.setattr(cmod, "load_password",
                        lambda k, u, p: "s3cret" if k == "cmdset:db01" else None)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh db01", "> @db01"])
    await asyncio.sleep(0.05)
    sess.push(b"Are you sure you want to continue connecting (yes/no)? ")
    await asyncio.sleep(0.5)
    # 密码不该被打进确认提示(那里回显,会明文泄漏)
    assert not any(c[1] == b"s3cret\r" for c in sess.calls if c[0] == "raw")
    # 随后真正的密码提示出现 → 应答正常发出
    sess.push(b"db01's password: ")
    await _wait(lambda: ("raw", b"s3cret\r") in sess.calls, timeout=5)
    # 确认提示窗口期还应有 status 提示跳过了该轮(容错不卡死由 timeout 承担)


# --- 提示符幕帘：任务期扣住提示符重绘，注入/收尾放行 ---

def _fake_ai_task(w):
    async def _noop():
        await asyncio.sleep(30)
    t = asyncio.create_task(_noop())
    w._ai_task = t
    return t


async def test_prompt_curtain_holds_prompt_during_task(monkeypatch):
    r"""任务运行期 prompt_start 关帘：提示符重绘的 live 文本扣住不发，
    开帘时按原序一次放行（对话未结束底部不出现空提示符）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    t = _fake_ai_task(w)
    await w._on_stream_event(("prompt_start", 1))
    assert w._curtain, "任务期 A 标记应关帘"
    await w._on_stream_event(("live", "[root@x ~]# "))
    await w._on_stream_event(("live", " 杂散回显"))
    await _wait(lambda: len(sink.messages) > 0 or True)   # 让 outbox 排空一拍
    await asyncio.sleep(0.05)
    assert b"root@x" not in _sink_bytes(sink), "扣留期提示符不得外发"
    assert w._curtain_parts == ["[root@x ~]# ", " 杂散回显"]
    await w._curtain_open()
    assert not w._curtain and w._curtain_parts == []
    await _wait(lambda: b"root@x" in _sink_bytes(sink))
    assert " 杂散回显".encode() in _sink_bytes(sink), "放行须按原序完整"
    t.cancel()


async def test_prompt_curtain_opens_on_pty_write(monkeypatch):
    r"""幕帘关着时任何 PTY 写入先开帘再写（命令/pad/口令注入全经
    session.send_raw，含 runner 直写）——字节序不变，只后移可见时机。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    t = _fake_ai_task(w)
    await w._on_stream_event(("prompt_start", 1))
    await w._on_stream_event(("live", "[root@x ~]# "))
    await w.session.send_raw(b"ls -la\r")
    await _wait(lambda: b"root@x" in _sink_bytes(sink))
    assert not w._curtain, "写入应开帘"
    assert ("raw", b"ls -la\r") in w.session.calls
    t.cancel()


async def test_prompt_curtain_idle_no_hold(monkeypatch):
    """空闲期（无任务）提示符照常透传，不关帘。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    assert w._ai_task is None
    await w._on_stream_event(("prompt_start", 1))
    assert not w._curtain
    await w._on_stream_event(("live", "[root@x ~]# "))
    await _wait(lambda: b"root@x" in _sink_bytes(sink))


async def test_prompt_curtain_released_at_task_end(monkeypatch):
    """任务收尾（_ai_flow finally）开帘：结束后 prompt_start 不再关帘。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)

    async def _fake_run(text, hooked=False):
        return

    monkeypatch.setattr(w, "_run_task", _fake_run)
    w._start_ai("查资源")
    await _wait(lambda: w._ai_task is None or w._ai_task.done(), timeout=5)
    t = _fake_ai_task(w)   # 幕帘再次关上（模拟下一任务中段）
    await w._on_stream_event(("prompt_start", 1))
    await w._on_stream_event(("live", "[root@x ~]# "))
    assert w._curtain
    # 模拟任务收尾路径本身的开帘（_ai_flow finally 同款调用）
    await w._curtain_open()
    await _wait(lambda: b"root@x" in _sink_bytes(sink))
    t.cancel()


async def test_pending_approval_resends_on_reattach(monkeypatch):
    """WS 断隙/刷新重挂补发未决审批（真机 2026-10-06 假死根因的 core 侧防线）。

    sender 在 sink=None 时静默丢帧——审批帧只发一次即可能落进断隙；
    attach 重挂必须凭 _pending_approval 补投同命令帧，决策落地后不再补。"""
    w, sink1 = await _make_worker(monkeypatch)
    try:
        task = asyncio.create_task(w.ask_approval(
            "rm -rf /tmp/ot_resend", "高危命令需要审批", "h", "high"))
        await _wait_json(sink1, lambda m: any(
            x.get("type") == "approval" for x in m))
        assert w._pending_approval is not None
        w.detach(sink1)
        sink2 = FakeSink()
        w.attach(sink2)
        msgs = await _wait_json(sink2, lambda m: any(
            x.get("type") == "approval"
            and x.get("command") == "rm -rf /tmp/ot_resend" for x in m))
        assert msgs, "重挂应补发同命令审批帧"
        await w._decisions.put({"type": "reject", "message": "用户拒绝了该命令"})
        assert await task == {"type": "reject", "message": "用户拒绝了该命令"}
        assert w._pending_approval is None
        sink3 = FakeSink()
        w.attach(sink3)
        await asyncio.sleep(0.15)
        assert not any(x.get("type") == "approval" for x in sink3.json()), \
            "决策落地后重挂不得再补发"
    finally:
        await w.close()


# --- 断线隙控制帧补发 + 任务卡死兜底（真机 2026-10-07「AI 正在思考」卡死）---


async def test_offline_control_frames_replay_on_reattach(monkeypatch):
    """断线隙里的 JSON 控制帧不得丢：任务终局帧丢了，前端「AI 正在思考」
    徽标永远收不到收尾（真机截图二 11m3s 卡死）。PTY 字节帧照旧丢——
    重放会与前端已有缓冲重复画屏。"""
    from openterminal.core import ServerMsg
    w, sink1 = await _make_worker(monkeypatch)
    try:
        w.detach(sink1)
        await w.emit_msg(ServerMsg(
            type="event", event={"kind": "final", "text": "答案正文"}))
        await w.emit_bytes(b"\x1b[31mred-only\x1b[0m")
        await w.emit_msg(ServerMsg(type="status", text="断线期的状态"))
        await asyncio.sleep(0.05)
        assert not sink1.json(), "detach 后不应再投给旧 sink"

        sink2 = FakeSink()
        w.attach(sink2)
        msgs = await _wait_json(sink2, lambda m: any(
            x.get("type") == "event" and x.get("event", {}).get("kind") == "final"
            for x in m) and any(x.get("type") == "status" for x in m))
        finals = [x["event"]["text"] for x in msgs
                  if x.get("type") == "event" and x.get("event", {}).get("kind") == "final"]
        assert finals == ["答案正文"]
        assert any(x.get("text") == "断线期的状态" for x in msgs), "控制帧按原序补发"
        assert b"red-only" not in _sink_bytes(sink2), "PTY 字节帧不补发"
    finally:
        await w.close()


async def test_offline_replay_is_not_repeated_on_next_attach(monkeypatch):
    """补发一次即清空：再次重挂不得把旧终局帧再投一遍（避免重复画卡）。"""
    from openterminal.core import ServerMsg
    w, sink1 = await _make_worker(monkeypatch)
    try:
        w.detach(sink1)
        await w.emit_msg(ServerMsg(
            type="event", event={"kind": "final", "text": "只补一次"}))
        await asyncio.sleep(0.05)
        sink2 = FakeSink()
        w.attach(sink2)
        await _wait_json(sink2, lambda m: any(
            x.get("event", {}).get("kind") == "final" for x in m))
        w.detach(sink2)
        sink3 = FakeSink()
        w.attach(sink3)
        await asyncio.sleep(0.15)
        assert not any(x.get("event", {}).get("kind") == "final"
                       for x in sink3.json()), "同帧不得重复补发"
    finally:
        await w.close()


async def test_send_failure_buffers_control_frames(monkeypatch):
    """sink 还挂着但发送抛错（网络刚断、detach 尚未回来）：控制帧不得丢。

    旧实现 except: continue 直接丢帧——断线瞬间发出的 final 就永久没了，
    前端徽标永远不收（真机「AI 正在思考」卡死）。"""
    from openterminal.core import ServerMsg

    class DeadSink:
        async def send_bytes(self, data):
            raise RuntimeError("ws dead")

        async def send_text(self, text):
            raise RuntimeError("ws dead")

    w, sink1 = await _make_worker(monkeypatch)
    try:
        w._sink = DeadSink()          # 网络已断、detach 还没回调
        await w.emit_msg(ServerMsg(
            type="event", event={"kind": "final", "text": "断线瞬间的收束"}))
        await asyncio.sleep(0.05)
        assert w._sink is None, "死 sink 应被摘掉，后续帧直接进攒帧路径"
        assert any(k == "json" and json.loads(p)["event"]["kind"] == "final"
                   for k, p in w._offline), w._offline

        sink2 = FakeSink()
        w.attach(sink2)
        msgs = await _wait_json(sink2, lambda m: any(
            x.get("event", {}).get("kind") == "final" for x in m))
        assert [x["event"]["text"] for x in msgs
                if x.get("event", {}).get("kind") == "final"] == ["断线瞬间的收束"]
    finally:
        await w.close()


class _HungAgent:
    """永远不产出片段的 agent：模拟网关挂起/连接半死。"""

    def astream(self, payload, cfg, stream_mode=None):
        async def _gen():
            await asyncio.Event().wait()
            yield ("messages", (None, {}))   # pragma: no cover
        return _gen()


async def test_task_stall_emits_error_and_ends(monkeypatch):
    """astream 无超时 → 任务永不收束 → 「AI 正在思考」永久不收（真机截图二）。
    静默看门狗必须把任务收成 error 事件。"""
    import openterminal.agent as amod
    monkeypatch.setattr(amod, "AGENT_STALL_TIMEOUT", 0.25)
    runner = amod.TaskRunner(_HungAgent(), "th-stall", max_tool_turns=10)
    events = await asyncio.wait_for(runner.run("x"), timeout=5)
    assert any(e.kind == "error" and "无响应" in e.text for e in events), events


async def test_task_stall_not_triggered_while_tool_pending(monkeypatch):
    """有在途工具＝命令真在跑（长构建合法）：短阈值不得误杀，只按工具阈值判。"""
    import openterminal.agent as amod
    monkeypatch.setattr(amod, "AGENT_STALL_TIMEOUT", 0.05)
    monkeypatch.setattr(amod, "AGENT_TOOL_TIMEOUT", 5.0)
    runner = amod.TaskRunner(_HungAgent(), "th-tool", max_tool_turns=10)
    runner._pending_tools["t1"] = (1, "execute")   # 工具已开、结果没回
    task = asyncio.create_task(runner.run("x"))
    await asyncio.sleep(0.4)      # 远超 AGENT_STALL_TIMEOUT，但工具阈值未到
    assert not task.done(), "在途工具期间不得按模型静默阈值中止"
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
