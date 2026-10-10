"""web worker 单测（单管线 §5）：PTY 字节直写主 xterm 是唯一显示管线，
worker 只做记账（OSC 133/6337）、AI 任务与注入通道、非显示事件。
"""

import asyncio
import json
from types import SimpleNamespace

from openterminal.config import Config
from openterminal.web.protocol import ClientMsg
from openterminal.web.worker import TabWorker

from tests.web_fakes import (
    FakeRunner, FakeSession, FakeSink, PassthroughSession,
    _drain_fallback, _event_kinds, _events, _install_fake_runner,
    _make_worker, _profile, _run_failed_user_cmd, _sink_bytes,
    _skip_reintegrate, _wait, _wait_json, _wire_presenter,
)

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


async def test_worker_cmd_accounting_and_forward(monkeypatch, tmp_path):
    """CMD 报告的用户命令：不进 ctx 栈，_open_cmds 记账；输出字节直通；
    exec_end 记 transcript 退出码 + 历史库（source=user）。"""
    import openterminal.history_db as history_db

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True

    w._pending_report = (1, "CMD", "ls -la /tmp")
    await w.exec._on_exec_start(1)
    assert w._open_cmds == {1: "ls -la /tmp"}
    assert not w._exec_stack                       # 用户命令不进栈
    await w.exec._on_exec_text("file1\nfile2\n")        # 输出直通前端
    await _wait(lambda: b"file1\nfile2\n" in _sink_bytes(sink))
    await w.exec._on_exec_end(1, 0, "/tmp")
    assert 1 not in w._open_cmds

    got = [(r["source"], r["command"])
           for r in history_db.recent("10.0.0.20", 100)]
    assert ("user", "ls -la /tmp") in got


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
        await w.exec._on_exec_start(i + 1)
        assert w._exec_stack[-1]["ctx"] == "agent"
        await w.exec._on_exec_text("out-of-" + cmd + "\n")
        await w.exec._on_exec_end(i + 1, 0, "/tmp")
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
    await w.exec._on_exec_start(1)
    await w.exec._on_exec_end(1, 0, "/tmp")

    w.backend.on_start("df -h")
    fut = loop.create_future()
    w._exec_future = fut
    w._pending_report = (2, "EXEC", "df -h")
    await w.exec._on_exec_start(2)
    await w.exec._on_exec_end(2, 0, "/tmp")
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
    await w.exec._on_exec_start(1)
    assert w._exec_stack[-1]["ctx"] == "probe"
    await w.exec._on_exec_text("git\n")
    await w.exec._on_exec_end(1, 0, "/tmp")
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
    await w.exec._on_exec_start(1)
    assert w._exec_stack[-1]["ctx"] == "silent"
    await w.exec._on_exec_text("toggle noise\r\n")
    assert _sink_bytes(sink) == b""
    await w.exec._on_exec_end(1, 0, "/tmp")
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
    await w.exec._on_exec_start(1)
    assert w._exec_stack[-1]["ctx"] == "silent"
    await w.exec._on_exec_text("-bash: export: fake: not a function\n")
    assert _sink_bytes(sink) == b""          # 报错不外显
    await w.exec._on_exec_end(1, 0, "/tmp")
    assert not w._exec_stack
    assert _sink_bytes(sink) == b""          # 也不补收束换行

    w._pending_report = (1, "CMD", 'eval "$(echo "$__ot_inj" | base64 -d)"')
    await w.exec._on_exec_start(1)
    assert w._exec_stack[-1]["ctx"] == "silent"
    await w.exec._on_exec_end(1, 0, "/tmp")
    assert _sink_bytes(sink) == b""


async def test_worker_orphan_exec_end_ignored(monkeypatch):
    """无栈的 D 标记（孤儿）：忽略，不崩、不误记账。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    await w.exec._on_exec_end(9, 0, "/tmp")     # 从未开帧
    assert not w._exec_stack


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

    w.ai._start_ai("看看磁盘占用")
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

    w.ai._start_ai("读一下 notes.txt")
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

    w.ai._start_ai("第一读")
    await _wait(lambda: w._ai_task is None)
    w.ai._start_ai("第二读")
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

    w.ai._start_ai("看看磁盘占用")
    await _wait(lambda: w._ai_task is None)
    usage = await _wait_json(sink, lambda m: any(
        x["type"] == "usage" and x.get("tokens_in") == 640 for x in m))
    assert any(x.get("tokens_out") == 128 for x in usage)
    assert any(x.get("estimated") for x in usage)

    # 第二个任务继续累计（估算口径逐任务叠加）
    w.ai._start_ai("再看内存")
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
    await w.ai._on_ai_line("第一句")
    await w.ai._on_ai_line("第二句")
    assert w._ai_queue == [("第一句", False), ("第二句", False)]

    blocker.cancel()
    try:
        await blocker
    except asyncio.CancelledError:
        pass
    w._ai_task = None
    _q = w._ai_queue.pop(0)
    w.ai._start_ai(_q[0], _q[1])             # 触发回放；后续由 finally 链式接续
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

    w.ai._start_ai("?df -h 是干嘛的")
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

    w.ai._start_ai("/tmp/no_such_script.sh --prod")
    await _wait(lambda: w._ai_task is None)
    ts = _events(sink, "task_start")
    assert [e["text"] for e in ts] == ["/tmp/no_such_script.sh --prod"]


async def test_worker_slash_clear_resets_transcript(monkeypatch):
    """/clear：新 transcript + 状态提示 + session_cleared 事件 + 原生 Ctrl+L 清屏。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    old = w.transcript
    await w.ai._handle_slash("/clear")
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
    await w.ai._handle_slash("/model")
    await w.ai._handle_slash("/target")
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


async def test_runner_timeout_force_returns_130(monkeypatch):
    # 回归：InteractiveRunner 超时发 Ctrl+C 后按 130 返回；栈/future 清理干净，
    # _wait_exec_idle 不再永久忙
    from openterminal.web.worker import InteractiveRunner

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._shell_kind = "bash"
    w._b64flag = "-d"
    w._last_mark_at = 1.0          # P0-1 门禁：hook 在位才允许注入
    runner = InteractiveRunner(w)
    res = await asyncio.wait_for(
        runner.run("sleep 100", timeout=0.3, on_output=None), timeout=5)
    assert res.exit_code == 130
    assert w._exec_future is None
    assert w._suppress_live is False
    # Ctrl+C 已发（\x15 收半行 + \x03 中断）；hook 在位时收尾照常发
    # \x19 接回半行——「不 yank」是 hook 不在位的口径，见 P2-5 用例
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert b"\x03" in raws and raws[-1] == b"\x19"
    assert await asyncio.wait_for(w.ai._wait_exec_idle(0.1), timeout=2)


async def test_runner_sends_yank_restore_when_hook_ok(monkeypatch):
    """hook 在位：命令注入 \x15 收纳半行、执行收尾发 \x19 接回（真机「任务
    期打字只剩尾巴」根因修复）。hook 不在位的口径见 P0-1 门禁用例：根本不
    注入，自然也没有 \x19（原生 ^Y 会复活 kill ring 旧内容）。"""
    from openterminal.web.worker import InteractiveRunner

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._shell_kind = "bash"
    w._b64flag = "-d"
    w._last_mark_at = 1.0
    runner = InteractiveRunner(w)
    t = asyncio.ensure_future(
        runner.run("docker ps", timeout=5, on_output=None))
    await _wait(lambda: any(d == b"\x15"
                            for k, d in w.session.calls if k == "raw"))
    await asyncio.sleep(0.05)
    # 直接 resolve：喂 exec_start 流事件会刷新 _last_mark_at（C 帧标记本身
    # 就是 hook 在位的凭据），这里保持门禁口径干净
    from openterminal.web.worker import CommandResult
    w._exec_future.set_result(CommandResult(
        output="CONTAINER ID\n", exit_code=0, truncated=False, cwd="/tmp"))
    await asyncio.wait_for(t, timeout=5)
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert raws[0] == b"\x15"
    assert raws[-1] == b"\x19", "hook 在位：注入收尾必须发 \\x19 接回半行"


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


async def test_runner_timeout_hook_dead_skips_ctrl_c(monkeypatch):
    """P2-5 收尾降级：执行途中壳死（TMOUT 登出落回裸壳）后超时收尾不再发
    \x03/\x19——hook 不在位时那两个字节也是落进裸壳的垃圾。"""
    from openterminal.web.worker import InteractiveRunner

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._shell_kind = "bash"
    w._b64flag = "-d"
    w._last_mark_at = 1.0          # 门禁放行：注入那一刻 hook 尚在位
    orig = w.session.send_raw

    async def _raw(data):
        await orig(data)
        if b"__ot_exec__" in data:
            w._hook_stale = True   # 注入落地后壳死（TMOUT 自动登出）
    w.session.send_raw = _raw

    runner = InteractiveRunner(w)
    res = await asyncio.wait_for(
        runner.run("sleep 100", timeout=0.3, on_output=None), timeout=5)
    assert res.exit_code == 130
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert any(b"__ot_exec__" in d for d in raws), "门禁放行时该正常注入"
    assert not any(d in (b"\x03", b"\x19") for d in raws), \
        "hook 不在位：\\x03/\\x19 都是落进裸壳的垃圾（P2-5）"


async def test_runner_hook_gone_fast_fails_zero_bytes(monkeypatch):
    """P0-1 门禁（结构性不可集成）：快速失败回可读文案，PTY 输入流零字节。"""
    from openterminal.web.worker import (
        CHANNEL_DEAD_EC, CHANNEL_DEAD_MSG, InteractiveRunner)

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._shell_kind = "bash"
    w._b64flag = "-d"
    w._hook_gone = True            # su - 换壳 / 旧版 shell：不可集成

    runner = InteractiveRunner(w)
    res = await asyncio.wait_for(
        runner.run("df -h", timeout=1, on_output=None), timeout=5)
    assert res.exit_code == CHANNEL_DEAD_EC
    assert res.output == CHANNEL_DEAD_MSG and "重新登录" in res.output
    assert w._exec_future is None
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert raws == [], "结构性不可集成：不空转注入，PTY 输入流一字节不发"


async def test_probe_failure_reports_status_once(monkeypatch):
    """P2-6：重注入探测判定不可集成时回一条中文状态告知前端（同一 shell
    只报一次），不让后续任务静默失败。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "_PROBE_TIMEOUT", 0.05)

    def _count_unusable():
        return len([x for x in sink.json()
                    if x.get("type") == "status"
                    and "无法集成" in x.get("text", "")])

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0

    assert await w.hook._ensure_integrated() is False
    assert w._hook_gone is True
    await _wait_json(sink, lambda m: any(
        x.get("type") == "status" and "无法集成" in x.get("text", "")
        for x in m))
    before = _count_unusable()

    assert await w.hook._ensure_integrated() is False
    await asyncio.sleep(0.05)
    assert _count_unusable() == before, "同一 shell 不重复播报"


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
    await w.exec._on_stream_event(("report", 1, "AI", "帮我查询系统资源"))
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
    await w.exec._on_stream_event(("report", 1, "CMD", "帮我查询系统资源"))
    assert w._hook_report_pending is None
    await _drain_fallback(w)
    assert w._ai_task is None      # CMD 上报即兜底撤销，不起 AI 任务


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
    await w.exec._on_stream_event(("report", 1, "AI", real))
    assert w._hook_report_pending is None
    await asyncio.wait_for(w._ai_task, timeout=2)
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and x["event"]["text"] == real for x in m))
    await _drain_fallback(w)


async def test_worker_submit_dirty_hook_dead_silent_start(monkeypatch):
    """hook 不在位 + 镜像 dirty：任务先行——镜像文本立即起任务（task_start
    毫秒级，文字由卡的 text 承接），清场（\\x15/\\x03）后台并行；残镜像不重发
    （尾巴会被画屏并送 AI，真机截图根因）。"""
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
    assert "的别名\r".encode() not in raws, "残镜像不得当整行重发"
    assert w._hook_report_pending is None
    assert w._ai_task is not None, "任务先行：不等清场/重注入"
    task = w._ai_task
    await asyncio.wait_for(task, timeout=2)
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and x["event"]["text"] == "的别名" for x in m))
    await asyncio.sleep(0.8)       # 后台清场（0.12+0.4s）落地
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert b"\x15" in raws and b"\x03" in raws, "清场后台并行发生"
    await _drain_fallback(w)


async def test_worker_submit_hook_dead_task_first(monkeypatch):
    """hook 不在位（注入失败 / 裸 shell）：任务先行——task_start 立即出发
    （文字由分析卡承接，不再让用户对着擦掉的空行干等重注入 4-6s，真机根因）；
    清场 \\x15→\\x03 后台并行；整行不重发（无蓝色重绘，重注入改由 _run_task
    的 not hooked 分支在任务内完成）。"""
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
    assert "帮我查询系统资源\r".encode() not in raws, "降级不再整行重发"
    assert w._hook_report_pending is None
    assert w._ai_task is not None, "任务先行：提交即起跑"
    task = w._ai_task
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and x["event"]["text"] == "帮我查询系统资源" for x in m))
    await asyncio.wait_for(task, timeout=2)
    await asyncio.sleep(0.8)       # 后台清场（0.12+0.4s）落地
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert raws.index(b"\x15") < raws.index(b"\x03"), "清行先于 ^C：^C 后是新提示符行"
    await _drain_fallback(w)


async def test_worker_submit_hook_dead_reintegrate_fails_silent_start(monkeypatch):
    """重注入失败（老 shell / 2s 无标记回执）：任务不悬空——任务先行照常
    起跑（文字由分析卡承接），重注入在任务内失败不阻断；整行不重发（无回显），
    与既有失联行为一致。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 0.0          # hook 不在位：走降级且重注入失败
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)

    async def _fail():
        return False
    monkeypatch.setattr(w.hook, "_ensure_integrated", _fail)

    n = len([c for c in w.session.calls if c[0] == "raw"])
    await w.handle_client(ClientMsg(type="submit", text="帮我查询系统资源"))
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert "帮我查询系统资源\r".encode() not in raws, "重注入失败不得重发行"
    assert w._ai_task is not None, "任务先行：重注入失败不阻断起跑"
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
    await w.exec._on_stream_event(("report", 1, "AI", "帮我查询系统资源"))
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


async def test_hooked_flag_threads_through_start_ai(monkeypatch):
    """hook 上报触发的任务带 hooked=True 一路传到 _ai_flow：_run_task 据此跳过
    重注入（注入吞窗口吃在途蓝色重绘字节＝真机「提交行消失」根因）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    seen = []

    async def fake_flow(line, hooked=False):
        seen.append((line, hooked))

    w.ai._ai_flow = fake_flow
    w.ai._start_ai("甲", True)
    await asyncio.sleep(0)
    assert seen == [("甲", True)]
    w._ai_task = None
    w.ai._start_ai("乙")
    await asyncio.sleep(0)
    assert seen[-1] == ("乙", False)


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
    import openterminal.agent.runner as amod
    monkeypatch.setattr(amod, "AGENT_STALL_TIMEOUT", 0.25)
    runner = amod.TaskRunner(_HungAgent(), "th-stall", max_tool_turns=10)
    events = await asyncio.wait_for(runner.run("x"), timeout=5)
    assert any(e.kind == "error" and "无响应" in e.text for e in events), events


async def test_task_stall_not_triggered_while_tool_pending(monkeypatch):
    """有在途工具＝命令真在跑（长构建合法）：短阈值不得误杀，只按工具阈值判。"""
    import openterminal.agent.runner as amod
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
