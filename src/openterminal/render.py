"""rich 输出助手。"""

from __future__ import annotations

from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax
from rich.text import Text

console = Console()


def print_command(command: str, host: str, *, approved: bool = False) -> int:
    """打印命令面板；返回面板占用的屏幕行数（供审批结束后擦除）。

    行数用 capture 预渲染计数（与实际打印同一个 console，宽度一致），
    命令很长被 word_wrap 折行时同样准确。
    """
    tag = "执行" if approved else "将执行"
    panel = Panel(Syntax(command, "bash", word_wrap=True, theme="ansi_dark"),
                  title=f"[bold cyan]{tag}[/] · {host}", border_style="cyan")
    with console.capture() as cap:
        console.print(panel)
    rows = cap.get().count("\n")
    console.print(panel)
    return rows


def print_denied(text: str) -> None:
    console.print(f"[bold red]✗ {text}[/]")


def print_summary(text: str) -> None:
    """最终总结框。Text 包一层：模型输出里的 [xx] 不当 rich 标记解析。"""
    console.print(Panel(Text(text), title="[bold green]📝 总结[/]",
                        title_align="left", border_style="green"))


def print_answer(text: str) -> None:
    console.print(Panel(text, title="[bold green]OpenTerminal[/]",
                        border_style="green"))
