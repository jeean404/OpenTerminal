"""ot / openterminal 入口。"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from .config import Config, app_dir


def main() -> None:
    for p in (Path.cwd() / ".env", app_dir() / ".env"):
        if p.exists():
            load_dotenv(p)
    cfg = Config.load()
    # ot web [--host X] [--port N] [--token T] [--no-open]
    if len(sys.argv) >= 2 and sys.argv[1] == "web":
        from .web.server import run_web

        run_web(cfg, argv=sys.argv[2:])
        return
    # ot exec -t <目标> -c <命令> / ot list targets —— 无头执行面（headless.py）
    # 输出要保持纯净供脚本消费，不打印欢迎横幅
    if len(sys.argv) >= 2 and sys.argv[1] in {"exec", "list"}:
        from .headless import run_headless

        raise SystemExit(run_headless(sys.argv[1:], cfg=cfg))
    from .banner import print_banner

    print_banner()
    # ot connect <ssh配置别名> / ot ssh user@host:port
    initial = None
    if len(sys.argv) >= 3 and sys.argv[1] in {"connect", "ssh"}:
        initial = sys.argv[2]
    # 无目标参数 → 启动选择框（local / 记住的连接 / 添加新连接）
    # Cli 惰性导入：cli→term_frontend→core 链很重，只有交互 CLI 分支才需要；
    # `ot list`/`ot exec`/`ot web` 走上面的早返回，不该付这份导入成本。
    from .cli import Cli

    cli = Cli(cfg, initial_target=initial)
    try:
        asyncio.run(cli.loop())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
