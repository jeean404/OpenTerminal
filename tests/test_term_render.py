"""CLI 内联渲染器单测（Task 4）：事件映射 + 状态行 + 零占位协议。

构造按计划 Task 4 Step 1：FakeCore（只记录 feed_msg——渲染器对核心的唯一
上行是 ai_boundary 的 boundary_settled 回执）+ StringIO console（
force_terminal=False, width=100；dim/边框色断言另开 force_terminal=True 查
ANSI）+ 直调 ``await renderer.render(ServerMsg(...))``。

流式（ai_token/ai_think）与状态行不经 rich console，直接走 frontend 的
writer（保持与 PTY 字节串行，Review Focus #3）；_make_renderer 把假 writer
接到同一个 sink，console 输出与字节流在断言里合流可见。
"""
import asyncio
import time
from io import StringIO

from rich.console import Console

from openterminal.core import ClientMsg, ServerMsg
from openterminal.term_frontend import CliRenderer, TermFrontend


class FakeCapture:
    """_CaptureLayer 桩的记录替身（Task 5 换真实现；调用形状此刻钉死）。"""

    def __init__(self):
        self.calls = []

    def enter_approval(self, risk):
        self.calls.append(("approval", risk))

    def enter_rescue(self):
        self.calls.append(("rescue",))

    def enter_auth(self, kind):
        self.calls.append(("auth", kind))


class _SinkFile:
    """rich Console 的 file-like：写入直接落到 sink（StringIO）。"""

    def __init__(self, sink):
        self._sink = sink

    def write(self, s):
        self._sink.write(s)
        return len(s)

    def flush(self):
        pass


class FakeFrontend:
    def __init__(self, sink):
        self._sink = sink
        self.capture = FakeCapture()
        self._outbox = asyncio.Queue()

    def _writer(self, data):
        self._sink.write(data.decode("utf-8", "replace"))


class FakeCore:
    """渲染器只调 feed_msg（boundary ack）；_frontend 供渲染器取
    writer/capture（CliCore 两段构造同形状）。"""

    def __init__(self, frontend):
        self.fed = []
        self._frontend = frontend

    async def feed_msg(self, msg):
        self.fed.append(msg)


def _make_renderer(*, force_terminal=False):
    sink = StringIO()
    fake_fe = FakeFrontend(sink)
    core = FakeCore(fake_fe)
    console = Console(file=_SinkFile(sink), force_terminal=force_terminal,
                      width=100)
    renderer = CliRenderer(core, console, frontend=fake_fe)
    return renderer, sink, core


def _ev(kind, **kw):
    return ServerMsg(type="event", event={"kind": kind, **kw})


async def _never_reader():
    await asyncio.sleep(3600)
    return b""


def _frontend_env():
    """真 TermFrontend（不跑 run()）+ 列表 writer：擦除协议/tick 接线用。"""
    written = []
    fe = TermFrontend(core=None, reader=_never_reader)
    fe._writer = lambda d: written.append(d)
    return fe, written


# --- 计划 Task 4 Step 1 的 14 例 ---

async def test_ready_interactive_line():
    r, sink, _ = _make_renderer()
    await r.render(ServerMsg(type="ready", host="h1", user="root",
                             distro="Debian", interactive=1))
    out = sink.getvalue()
    assert "h1" in out and "root" in out and "Debian" in out
    assert "AI 就绪" in out


async def test_ready_noninteractive_warns():
    r, sink, _ = _make_renderer()
    await r.render(ServerMsg(type="ready", host="h1", user="root"))
    assert "AI 不可用：shell 不支持集成" in sink.getvalue()


async def test_final_renders_summary():
    r, sink, _ = _make_renderer()
    r.status.activate("任务进行中")
    await r.render(_ev("final", text="完成 X"))
    assert "完成 X" in sink.getvalue()      # 总结面板框内
    assert not r.status.active              # final → 状态行定格


async def test_status_single_line():
    r, sink, _ = _make_renderer()
    await r.render(ServerMsg(type="status", text="已切换"))
    assert "已切换" in sink.getvalue()


async def test_usage_updates_status_tokens():
    r, sink, _ = _make_renderer()
    r.status.activate("任务进行中")
    await r.render(ServerMsg(type="usage", tokens_in=1200, tokens_out=34,
                             estimated=True))
    r.status.redraw()
    text = sink.getvalue()
    assert "≈1.2k" in text and "34" in text


async def test_ai_boundary_acks_immediately():
    r, sink, core = _make_renderer()
    await r.render(_ev("ai_boundary"))
    assert len(core.fed) == 1
    m = core.fed[0]
    assert isinstance(m, ClientMsg) and m.type == "boundary_settled"
    assert sink.getvalue() == ""            # 零渲染（零占位协议 §3.4）


async def test_padded_and_new_session_ignored():
    r, sink, _ = _make_renderer()
    await r.render(_ev("padded", rows=3))
    await r.render(_ev("new_session"))
    assert sink.getvalue() == ""


async def test_denied_and_error_lines():
    r, sink, _ = _make_renderer()
    await r.render(_ev("denied", text="不允许"))
    await r.render(_ev("error", text="炸了"))
    out = sink.getvalue()
    assert "不允许" in out and "炸了" in out
    assert not r.status.active              # 失败事件 → 状态行定格


async def test_stage_agent_init():
    r, sink, _ = _make_renderer()
    await r.render(ServerMsg(type="stage", text="agent_init"))
    assert "正在初始化 Agent…" in sink.getvalue()


async def test_token_stream_appends():
    r, sink, _ = _make_renderer()
    await r.render(_ev("ai_token", text="he"))
    await r.render(_ev("ai_token", text="llo"))
    assert sink.getvalue() == "hello"       # 流式拼接，无重复换行


async def test_think_stream_dim():
    r, sink, _ = _make_renderer()
    await r.render(_ev("ai_think", text="想想"))
    out = sink.getvalue()
    assert "想想" in out and "\x1b[2m" in out and "\x1b[22m" in out
    await r.render(_ev("ai_collapse", command="ls"))
    out = sink.getvalue()
    assert "思考 1 行" in out               # 思考段收束定格
    assert "ls" in out                      # 命令面板


async def test_erase_before_bytes():
    fe, written = _frontend_env()
    loop = asyncio.create_task(fe._render_loop())
    try:
        await asyncio.sleep(0)
        fe.status.activate("任务进行中")
        fe._outbox.put_nowait(("bytes", b"pty"))
        await asyncio.sleep(0.05)
    finally:
        loop.cancel()
    joined = b"".join(written)
    assert b"\r\x1b[K" in joined            # 写前擦状态行
    i = joined.index(b"pty")
    assert joined[:i].endswith(b"\r\x1b[K")  # 擦除紧贴 payload 之前
    assert "任务进行中".encode() in joined[i + 3:]   # 写后重画


async def test_approval_panel_content():
    r, sink, _ = _make_renderer()
    await r.render(ServerMsg(type="approval", command="rm -rf /tmp/x",
                             reasons="删除", host="h1", risk="high"))
    out = sink.getvalue()
    assert "rm -rf /tmp/x" in out and "删除" in out and "h1" in out
    assert ("approval", "high") in r._frontend.capture.calls
    # 风险色：high → 红边框（另开 force_terminal console 查 ANSI）
    r2, sink2, _ = _make_renderer(force_terminal=True)
    await r2.render(ServerMsg(type="approval", command="cmd", reasons="r",
                              host="h", risk="high"))
    assert "\x1b[31m" in sink2.getvalue()


async def test_rescue_panel_and_decide():
    r, sink, _ = _make_renderer()
    await r.render(_ev("rescue", line="gti status", ec=127,
                       output="command not found"))
    out = sink.getvalue()
    assert "gti status" in out and "127" in out
    assert ("rescue",) in r._frontend.capture.calls
    await r.render(_ev("rescue_decide", accept=True))
    assert "已交给 AI" in sink.getvalue()
    r2, sink2, _ = _make_renderer()
    await r2.render(_ev("rescue_decide", accept=False))
    assert "已忽略" in sink2.getvalue()


# --- 追加覆盖（只加不减）---

async def test_decide_receipt_line():
    r, sink, _ = _make_renderer()
    await r.render(_ev("decide", decision={"type": "approve"}))
    assert "✓ 已执行" in sink.getvalue()
    await r.render(_ev("decide", decision={"type": "reject"}))
    assert "✗ 已拒绝" in sink.getvalue()


async def test_cmdset_progress_line():
    r, sink, _ = _make_renderer()
    await r.render(ServerMsg(type="cmdset", state="running", index=2, total=5))
    assert "命令集 2/5" in sink.getvalue()


async def test_task_start_activates_status():
    r, sink, _ = _make_renderer()
    await r.render(_ev("task_start", text="做点事"))
    assert r.status.active
    r.status.redraw()
    assert "任务进行中" in sink.getvalue() and "0s" in sink.getvalue()


async def test_session_cleared_line_and_reset():
    r, sink, _ = _make_renderer()
    await r.render(_ev("ai_think", text="旧段"))
    await r.render(_ev("session_cleared"))
    out = sink.getvalue()
    assert "已开启新任务" in out
    assert r._think_text == "" and not r._think_open   # 思考流复位


async def test_ask_password_and_host_key_prompt():
    r, sink, _ = _make_renderer()
    await r.render(ServerMsg(type="ask_password", label="root 的密码"))
    assert "root 的密码" in sink.getvalue()
    assert ("auth", "password") in r._frontend.capture.calls
    await r.render(ServerMsg(type="ask_host_key", message="指纹 XX"))
    assert "指纹 XX" in sink.getvalue()
    assert ("auth", "host_key") in r._frontend.capture.calls


async def test_closed_single_line():
    r, sink, _ = _make_renderer()
    r.status.activate("任务进行中")
    await r.render(ServerMsg(type="closed", text="已关闭"))
    assert "会话已结束" in sink.getvalue()
    assert not r.status.active


async def test_status_spinner_advances():
    r, sink, _ = _make_renderer()
    r.status.activate("任务进行中")
    r.status.redraw()
    r.status.redraw()
    out = sink.getvalue()
    assert "⠋" in out and "⠙" in out      # 转轮按重画步进


async def test_status_elapsed_uses_monotonic(monkeypatch):
    r, sink, _ = _make_renderer()
    base = time.monotonic()
    monkeypatch.setattr(time, "monotonic", lambda: base + 12.4)
    r.status.activate("任务进行中")
    monkeypatch.setattr(time, "monotonic", lambda: base + 24.9)
    r.status.redraw()
    assert "12s" in sink.getvalue()


async def test_on_msg_delegates_to_renderer():
    fe, written = _frontend_env()
    await fe._on_msg(ServerMsg(type="status", text="委托"))
    assert "委托".encode() in b"".join(written)


async def test_tick_redraws_status():
    fe, written = _frontend_env()
    fe.status.activate("任务进行中")
    fe._outbox.put_nowait(("tick", None))
    loop = asyncio.create_task(fe._render_loop())
    try:
        await asyncio.sleep(0.05)
    finally:
        loop.cancel()
    assert "任务进行中".encode() in b"".join(written)
