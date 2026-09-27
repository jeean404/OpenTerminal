"""TaskPresenter 纯逻辑测试：sink 与 stream 全部用假对象。"""

import io

from openterminal.taskview import TaskPresenter


class FakeStream:
    def __init__(self):
        self.shown: list[str] = []   # 每次 show 的文本快照（"" 表示 spinner）
        self.halts = 0
        self.boxes: list[str] = []   # 定格的思考框

    def show(self, text: str) -> None:
        self.shown.append(text)

    def halt(self) -> None:
        self.halts += 1

    def box(self, text: str) -> None:
        self.boxes.append(text)


def make_presenter():
    out: list[str] = []
    panels: list[str] = []
    denied: list[str] = []
    errors: list[str] = []
    summaries: list[str] = []
    stream = FakeStream()
    p = TaskPresenter(
        emit=out.append,
        command_panel=panels.append,
        denied_line=denied.append,
        error_line=errors.append,
        summary_panel=summaries.append,
        stream=stream,
    )
    return p, out, panels, denied, errors, summaries, stream


def test_full_flow_shows_thinking_command_output_and_summary():
    # 期望界面：💭思考框 → 命令面板 → 原样输出 → 📝总结框
    p, out, panels, _, _, summaries, stream = make_presenter()
    p.begin()
    assert stream.shown == [""]  # 无内容 → spinner
    p.on_token("我先看看有哪些容器。")
    assert stream.shown[-1] == "我先看看有哪些容器。"
    p.on_start("docker ps")
    assert stream.boxes == ["我先看看有哪些容器。"]  # 思考段定格成框
    assert panels == ["docker ps"]
    p.on_output("ee2ba05756a8 web\n")
    p.on_finish("docker ps", 0)
    assert out == ["ee2ba05756a8 web\n"]  # 输出原样，退出码 0 无附加行
    assert stream.shown[-1] == ""  # 命令结束 → 重新转圈等总结
    p.on_token("共 3 个容器在运行。")
    p.finish("共 3 个容器在运行。")
    # 已流式的最后一段就是总结，不与 final 文本重复打印
    assert summaries == ["共 3 个容器在运行。"]
    assert stream.boxes == ["我先看看有哪些容器。"]
    assert out == ["ee2ba05756a8 web\n"]


def test_benign_probe_failure_only_adds_exit_note():
    # command -v 探测缺工具合法地非零退出：只多一行提示，流程照常
    p, out, *_ = make_presenter()
    p.begin()
    p.on_start("command -v docker podman crictl")
    p.on_output("docker\n")
    p.on_finish("command -v docker podman crictl", 2)
    assert out == ["docker\n", "（命令退出码 2，非 0）\n"]
    p.on_token("有 docker，我列出容器。")
    p.finish("共 3 个容器。")
    assert "（命令退出码 2，非 0）" in "".join(out)


def test_no_streamed_tokens_uses_final_text():
    # 非流式模型 / 拒绝后直接收尾：总结来自 final 事件文本
    p, _, _, _, _, summaries, _ = make_presenter()
    p.begin()
    p.finish("命令失败了。")
    assert summaries == ["命令失败了。"]


def test_pure_text_answer_shows_summary_only():
    p, out, panels, _, _, summaries, _ = make_presenter()
    p.begin()
    p.on_token("open 命令在 macOS 上可以打开应用。")
    p.finish("open 命令在 macOS 上可以打开应用。")
    assert out == [] and panels == []
    assert summaries == ["open 命令在 macOS 上可以打开应用。"]


def test_denied_flushes_segment_then_denied_line():
    p, _, _, denied, _, summaries, stream = make_presenter()
    p.begin()
    p.on_token("我准备执行清理。")
    p.on_denied("命令被 OpenTerminal 安全策略拒绝：rm -rf /")
    assert stream.boxes == ["我准备执行清理。"]  # 先定格思考段
    assert any("rm -rf /" in d for d in denied)
    # 拒绝后模型改道：新流式段落作为总结呈现
    p.on_token("好的，换个安全方案。")
    p.finish("已改道。")
    assert summaries == ["好的，换个安全方案。"]


def test_reject_flushes_segment():
    p, _, _, denied, _, _, stream = make_presenter()
    p.begin()
    p.on_token("执行前说明。")
    p.on_reject()
    assert stream.boxes == ["执行前说明。"]
    assert any("已拒绝" in d for d in denied)


def test_limit_flushes_segment_and_prints_error():
    p, _, _, _, errors, _, stream = make_presenter()
    p.begin()
    p.on_token("我继续尝试。")
    p.on_limit("已达到工具调用预算（10 轮），任务停止。")
    assert stream.boxes == ["我继续尝试。"]
    assert errors == ["已达到工具调用预算（10 轮），任务停止。"]


def test_parallel_commands_spinner_only_after_all_finish():
    p, *_, stream = make_presenter()
    p.begin()
    p.on_start("sleep 0.1")
    p.on_start("echo two")
    n_shown = len(stream.shown)
    p.on_finish("sleep 0.1", 0)
    assert len(stream.shown) == n_shown  # 还有一条在跑，不转圈
    p.on_finish("echo two", 0)
    assert len(stream.shown) == n_shown + 1  # 全部结束 → 重新点亮


def test_pause_halts_stream_keeps_segment():
    # 审批 prompt 出现前必须停 Live，但思考段内容保留待定格
    p, *_, stream = make_presenter()
    p.begin()
    p.on_token("准备执行。")
    p.pause()
    assert stream.halts == 1
    p.on_start("touch x")
    assert stream.boxes == ["准备执行。"]


# --- ThinkingStream（rich 层）---


def test_thinking_stream_nontty_show_noop_box_prints():
    from rich.console import Console

    from openterminal.taskview import ThinkingStream

    buf = io.StringIO()
    con = Console(file=buf, force_terminal=False, width=60)
    s = ThinkingStream(con)
    s.show("思考内容")  # 非 TTY：不建 Live
    s.halt()
    s.box("思考内容")   # 非 TTY：静态打印
    assert "思考内容" in buf.getvalue()
    assert "思考过程" in buf.getvalue()


def test_thinking_stream_render_wraps_long_text():
    from rich.console import Console

    from openterminal.taskview import ThinkingStream

    buf = io.StringIO()
    con = Console(file=buf, force_terminal=False, width=40)
    s = ThinkingStream(con)
    s.box("很长的思考" * 30)
    # 框内容按 40 列折行，不会超宽
    assert max(len(line) for line in buf.getvalue().splitlines()) <= 40


def test_live_view_tails_long_text():
    # 直播帧只显示尾部：帧高永远很小，避免在屏幕底部滚动导致刷新错位
    from rich.console import Console

    from openterminal.taskview import ThinkingStream

    con = Console(file=io.StringIO(), width=100)
    s = ThinkingStream(con)
    s._text = "x" * 600
    r = s._render_live()
    buf = io.StringIO()
    Console(file=buf, width=100).print(r)
    out = buf.getvalue()
    assert "已省略前文" in out
    assert "x" * 300 not in out  # 前半段被截掉


def test_box_shows_full_text_even_when_live_tails():
    # 定格框（段落结束/总结）始终完整，不截断
    from rich.console import Console

    from openterminal.taskview import ThinkingStream

    buf = io.StringIO()
    con = Console(file=buf, force_terminal=False, width=100)
    s = ThinkingStream(con)
    s.box("x" * 600)
    out = buf.getvalue()
    assert "已省略前文" not in out
    # 折行不影响完整性：600 个字符一个不少
    assert out.count("x") == 600
