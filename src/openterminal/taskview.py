"""任务级展示策略：模型思考、命令面板、真实输出、总结分段成框。

模型文字全程可见：每个思考段经 Live 面板流式呈现（无内容时显示
"思考中…"动效），段落结束（命令开始/被拒/收尾）定格为独立框；最终总结
单独成"总结"框；命令输出原样透传，退出码非 0 只附一行提示。

TaskPresenter 不依赖 rich：展示经注入的 sink 与 stream 完成，便于纯逻辑
单测。CLI 层负责用 rich console 装配这些 sink 与 ThinkingStream。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol


class _Stream(Protocol):
    def show(self, text: str) -> None: ...
    def halt(self) -> None: ...
    def box(self, text: str) -> None: ...


@dataclass
class TaskPresenter:
    emit: Callable[[str], None]
    command_panel: Callable[[str], None]
    denied_line: Callable[[str], None]
    error_line: Callable[[str], None]
    summary_panel: Callable[[str], None]
    stream: _Stream | None = None

    def __post_init__(self) -> None:
        self.pending = 0
        self.segment_text = ""  # 当前思考段内容（展示与定格的唯一事实源）

    # --- 思考段 ---
    def _show(self) -> None:
        if self.stream is not None:
            self.stream.show(self.segment_text)

    def begin(self) -> None:
        self.segment_text = ""
        self._show()  # 无内容 → spinner"思考中…"

    def pause(self) -> None:
        # Live 必须在 prompt_toolkit 接管终端前停掉；segment_text 保留，
        # 段落收尾时照常定格成框
        if self.stream is not None:
            self.stream.halt()

    def on_token(self, text: str) -> None:
        if not text:
            return
        self.segment_text += text
        self._show()

    def _segment_end(self) -> None:
        """当前思考段收尾：有内容则定格成框。"""
        if self.stream is not None:
            self.stream.halt()
            if self.segment_text:
                self.stream.box(self.segment_text)
        self.segment_text = ""

    # --- 命令生命周期（backend 回调）---
    def on_start(self, command: str) -> None:
        self._segment_end()
        self.pending += 1
        self.command_panel(command)

    def on_output(self, text: str) -> None:
        if text:
            self.emit(text)

    def on_finish(self, command: str, exit_code: int) -> None:
        self.pending = max(0, self.pending - 1)
        if exit_code != 0:
            # 非零退出只提示、不当失败：探测类命令非零退出是常态
            # （command -v 查缺工具、ls 探测、grep 无匹配都是非零）
            self.emit(f"（命令退出码 {exit_code}，非 0）\n")
        if self.pending == 0:
            # 命令都结束了，等模型继续思考/总结 → 重新点亮 Live
            self._show()

    # --- 拒绝/预算 ---
    def on_denied(self, text: str) -> None:
        self._segment_end()
        self.denied_line(text.split("\n")[0])

    def on_reject(self) -> None:
        self._segment_end()
        self.denied_line("已拒绝该命令，模型将改道或说明。")

    def on_limit(self, text: str) -> None:
        self._segment_end()
        self.error_line(text)

    def on_error(self, text: str) -> None:
        self.on_limit(text)

    # --- 收尾 ---
    def finish(self, final_text: str) -> None:
        # 最后一个流式段落就是总结，定格成总结框；没流式过（如非流式
        # 模型、或被拒后直接收尾）才用 final 事件文本，避免内容重复
        text = self.segment_text or final_text
        if self.stream is not None:
            self.stream.halt()
        self.segment_text = ""
        if text:
            self.summary_panel(text)


class ThinkingStream:
    """模型思考段的 Live 展示：无内容转圈"思考中…"，有内容实时刷新；
    段落结束由调用方 box() 定格成完整框。

    防刷屏三件套（真机踩坑：直播帧变高后会在屏幕底部滚动，光标定位
    错乱导致每次刷新整帧追加，看起来像死循环）：
    - 直播视图只展示尾部少量字符，帧高远小于终端高度，覆盖刷新不失位
    - Live 用 transient：halt 时擦掉活动帧，box() 再打印完整内容不重复
    - 渲染对象每次刷新按最新文本重建（_LiveView），无需逐 token update

    非 TTY（测试/管道）下 Live 不可用：show/halt 空操作，box() 直接
    静态打印。与 prompt_toolkit 不能同时占用终端：任何输入 prompt
    出现前调用方必须先 halt()。
    """

    _TAIL_CHARS = 240  # 直播视图最多展示的尾部字符数（完整内容在定格框里）

    def __init__(self, console, title: str = "💭 思考过程") -> None:
        self._console = console
        self._title = title
        self._live = None
        self._text = ""

    def _panel(self, text: str):
        from rich.panel import Panel
        from rich.spinner import Spinner
        from rich.text import Text

        if text:
            return Panel(Text(text), title=self._title,
                         title_align="left", border_style="cyan")
        return Panel(Spinner("dots", text="思考中…"), title=self._title,
                     title_align="left", border_style="cyan")

    def _render_live(self):
        text = self._text
        if len(text) > self._TAIL_CHARS:
            text = "⋯（已省略前文，段落结束完整显示）\n" + text[-self._TAIL_CHARS:]
        return self._panel(text)

    def show(self, text: str) -> None:
        if not self._console.is_terminal:
            return
        self._text = text
        if self._live is None:
            from rich.live import Live

            self._live = Live(_LiveView(self), console=self._console,
                              refresh_per_second=6, transient=True)
            self._live.start()

    def halt(self) -> None:
        if self._live is not None:
            self._live.stop()
            self._live = None

    def box(self, text: str) -> None:
        self.halt()
        self._text = ""
        self._console.print(self._panel(text))


class _LiveView:
    """Live 每次刷新调用：按流对象的最新状态重建渲染。"""

    def __init__(self, stream: ThinkingStream) -> None:
        self._stream = stream

    def __rich_console__(self, console, options):
        yield self._stream._render_live()


class ThinkingIndicator:
    """rich console.status 的可复用 start/stop 封装；非 TTY 下完全空操作。

    用于主循环里"判断中…"这类短等待；任务内的模型思考由 ThinkingStream
    呈现。rich Live 与 prompt_toolkit 不能同时占用终端：所有输入 prompt
    （审批、主输入行）出现前调用方必须先 stop()。
    """

    def __init__(self, console, text: str = "思考中…") -> None:
        self._console = console
        self.text = text
        self._status = None
        self.busy = False

    def start(self, text: str | None = None) -> None:
        if not self._console.is_terminal:
            return
        if text is not None:
            self.text = text
        if self._status is None:
            self._status = self._console.status(self.text, spinner="dots")
        else:
            self._status.update(self.text)
        if not self.busy:
            self._status.start()
            self.busy = True

    def stop(self) -> None:
        if self._status is not None and self.busy:
            self._status.stop()
        self.busy = False
