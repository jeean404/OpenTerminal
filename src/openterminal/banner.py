"""启动欢迎横幅（Spring Boot banner 风格）。

字形由 pyfiglet "standard" 字体生成后固化为常量——运行时不引入该依赖。
"""

from __future__ import annotations

import sys

from rich.text import Text

from .render import console

_BANNER = r"""                        _                      _             _
  ___  _ __   ___ _ __ | |_ ___ _ __ _ __ ___ (_)_ __   __ _| |
 / _ \| '_ \ / _ \ '_ \| __/ _ \ '__| '_ ` _ \| | '_ \ / _` | |
| (_) | |_) |  __/ | | | ||  __/ |  | | | | | | | | | | (_| | |
 \___/| .__/ \___|_| |_|\__\___|_|  |_| |_| |_|_|_| |_|\__,_|_|
      |_|                                                        """


def _version() -> str:
    try:
        from importlib.metadata import version

        return version("openterminal")
    except Exception:
        return "0.1.0"


def print_banner() -> None:
    """打印 ASCII 横幅 + 版本信息行。无头模式（exec/list）不要调用。"""
    console.print(Text("\n" + _BANNER, style="bold green"))
    label, ver = " :: OpenTerminal ::", f"(v{_version()})"
    console.print(
        label + " " * (len(_BANNER.splitlines()[1]) - len(label) - len(ver))
        + ver + f"  ·  Python {sys.version.split()[0]}",
        style="green",
    )
    console.print()
