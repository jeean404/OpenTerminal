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
import re
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


async def test_token_stream_multiline_translates_newlines():
    """多行 token 的 \n 须翻成 \r\n：raw 态终端无 ONLCR，裸 \n 会阶梯错位。"""
    r, sink, _ = _make_renderer()
    await r.render(_ev("ai_token", text="row1\nrow2\n| 1 | a |"))
    out = sink.getvalue()
    assert out == "row1\r\nrow2\r\n| 1 | a |"
    assert "\n" not in out.replace("\r\n", "")   # 无裸 \n 残留


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _plain(line: str) -> str:
    return _ANSI_RE.sub("", line)


async def test_think_stream_dim():
    r, sink, _ = _make_renderer()
    await r.render(_ev("ai_think", text="想想"))
    out = sink.getvalue()
    assert "💭 思考" in out                    # 框顶标题
    assert "\x1b[34m" in out                   # 蓝色边框（现有色板）
    await r.render(_ev("ai_collapse", command="ls"))
    out = sink.getvalue()
    assert "想想" in out and "\x1b[2m" in out and "\x1b[22m" in out
    assert "思考 1 行" in out                   # 思考段收束定格
    assert "ls" in out                          # 命令面板
    assert "╰" in out                          # 框底收齐


async def test_think_box_lines_full_width():
    """框内每行 pad 到 console.width：左右边框始终对齐成矩形。"""
    from openterminal.term_frontend import _display_width
    r, sink, _ = _make_renderer()
    await r.render(_ev("ai_think", text="第一行"))
    await r.render(_ev("ai_think", text="，第二行更长一点\n"))
    await r.render(_ev("ai_think", text="尾巴没换行"))
    await r.render(_ev("ai_collapse", command=""))
    box = [l for l in sink.getvalue().split("\r\n")
           if _plain(l)[:1] in ("╭", "│", "╰")]     # 只数框线（摘要行在外）
    assert len(box) >= 4                          # 顶 + 2 内容 + 底
    assert {_display_width(_plain(l)) for l in box} == {100}


async def test_think_box_wraps_long_line():
    """超内宽行软折行（CJK 计 2 列），折后仍封右边框。"""
    from openterminal.term_frontend import _display_width
    r, sink, _ = _make_renderer()
    await r.render(_ev("ai_think", text="汉" * 80 + "\n"))
    await r.render(_ev("ai_collapse", command=""))
    lines = [l for l in sink.getvalue().split("\r\n") if l]
    content = [_plain(l) for l in lines if _plain(l).startswith("│")]
    assert len(content) >= 2                   # 160 列 > 内宽 96 → 折行
    assert all(_display_width(l) == 100 for l in content)


async def test_think_box_closed_by_token_without_summary():
    """token 打断思考：关框收底但不打 `… 思考 N 行`（摘要归 ai_collapse）。"""
    r, sink, _ = _make_renderer()
    await r.render(_ev("ai_think", text="想一半\n"))
    await r.render(_ev("ai_token", text="正文来了"))
    out = sink.getvalue()
    assert "╰" in out                          # 框已收底
    assert "思考" not in _plain(out).replace("💭 思考", "")  # 无摘要行
    assert "正文来了" in out


async def test_erase_before_bytes():
    """有尾换行的 payload：写前擦状态行、写后 fresh 恢复，tick 重画落新行。"""
    fe, written = _frontend_env()
    loop = asyncio.create_task(fe._render_loop())
    try:
        await asyncio.sleep(0)
        fe.status.activate("任务进行中")
        fe._outbox.put_nowait(("bytes", b"out\r\n"))
        await asyncio.sleep(0.05)
        fe._outbox.put_nowait(("tick", None))
        await asyncio.sleep(0.05)
    finally:
        loop.cancel()
    joined = b"".join(written)
    assert b"\r\x1b[K" in joined            # 写前擦状态行
    i = joined.index(b"out\r\n")
    assert joined[:i].endswith(b"\r\x1b[K")  # 擦除紧贴 payload 之前
    assert "任务进行中".encode() in joined[i + 5:]   # tick 后重画（新行落笔）


async def test_bytes_midline_hides_status():
    """无尾换行的 payload（半行回显）：写后光标在行中，状态行不得重画
    覆盖 PTY 输出（审查 blocker：bytes 分支曾无条件 redraw 抹掉输出）。"""
    fe, written = _frontend_env()
    loop = asyncio.create_task(fe._render_loop())
    try:
        await asyncio.sleep(0)
        fe.status.activate("任务进行中")
        fe._outbox.put_nowait(("bytes", b"pty"))
        await asyncio.sleep(0.05)
        fe._outbox.put_nowait(("tick", None))   # 行中 tick 也不得重画
        await asyncio.sleep(0.05)
    finally:
        loop.cancel()
    joined = b"".join(written)
    i = joined.index(b"pty")
    assert joined[:i].endswith(b"\r\x1b[K")     # 写前擦了
    assert "任务进行中".encode() not in joined[i + 3:]   # 行中绝不重画


async def test_progress_cr_frames_never_overwritten():
    """进度条 \\r 帧（b\"10%\\r\" + b\"20%\"）：裸 \\r 不算 fresh，状态行
    全程隐没，不覆盖任何一帧。"""
    fe, written = _frontend_env()
    loop = asyncio.create_task(fe._render_loop())
    try:
        await asyncio.sleep(0)
        fe.status.activate("任务进行中")
        fe._outbox.put_nowait(("bytes", b"10%\r"))
        await asyncio.sleep(0.05)
        fe._outbox.put_nowait(("bytes", b"20%"))
        await asyncio.sleep(0.05)
    finally:
        loop.cancel()
    joined = b"".join(written)
    assert b"10%\r20%" in joined                # 两帧原样到达
    i = joined.index(b"10%")
    assert "任务进行中".encode() not in joined[i:]   # 状态行全程未覆盖


async def test_status_truncated_to_terminal_width(monkeypatch):
    """窄终端：状态行按显示列宽截断（CJK 计 2 列），单行不折行。"""
    import openterminal.term_frontend as tmod
    monkeypatch.setattr(tmod, "_term_size", lambda: (40, 10))
    fe, written = _frontend_env()
    fe.status.activate("任务进行中")            # 文本约 15 显示列 > 9
    joined = b"".join(written)
    assert joined and joined[0:1] == b"\r"
    assert b"\n" not in joined                  # 单行（未折行）
    assert "任务进行中".encode() not in joined  # 超宽部分被截掉


async def test_winch_refreshes_console_width(monkeypatch):
    """SIGWINCH：core feed_msg(resize) 之外同步刷新 console.width
    （_WriterFile 非 tty，rich 无法自探）。"""
    import openterminal.term_frontend as tmod
    monkeypatch.setattr(tmod, "_term_size", lambda: (40, 120))
    fe, _ = _frontend_env()

    class _C:
        async def feed_msg(self, m):
            pass

    fe.core = _C()
    fe._console = Console(file=StringIO(), force_terminal=False, width=80)
    fe._on_winch()
    assert fe._console.width == 120
    await asyncio.sleep(0)                      # 让 resize task 跑完无告警


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
