"""Web 会话假件（Task 10 自 test_web_worker 集中）：FakeSink /
FakeSession / _make_worker 等跨测试文件共用的脚本化桩。"""

import asyncio
import json
import time
from types import SimpleNamespace
from openterminal.agent.sysprobe import SystemProfile
from openterminal.web.worker import TabWorker
from openterminal.config import Config


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
        from openterminal.session.base import CommandResult
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
    import openterminal.agent.runner as amod
    monkeypatch.setattr(amod, "TaskRunner", runner_cls)


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
    monkeypatch.setattr(w.hook, "_ensure_integrated", _noop)


async def _run_failed_user_cmd(w, line, ec, output="boom: command not found"):
    """模拟 hook 在位的用户命令完整帧：CMD 上报 → C → 输出 → D(ec)。"""
    await w.exec._on_stream_event(("report", 1, "CMD", line))
    await w.exec._on_stream_event(("exec_start", 1))
    await w.exec._on_stream_event(("exec", output))
    await w.exec._on_stream_event(("exec_end", 1, ec, "/root"))


def _fake_ai_task(w):
    async def _noop():
        await asyncio.sleep(30)
    t = asyncio.create_task(_noop())
    w._ai_task = t
    return t
