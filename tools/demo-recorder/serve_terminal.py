#!/usr/bin/env python3
"""终端 demo 录制服务：单管线 CLI + 脚本化 TaskRunner（无需模型网关）。

用法（被 record_terminal.py 经 pty.fork spawn，不直接手跑）::

    OPENTERMINAL_HOME=/tmp/ot-demo-home python tools/demo-recorder/serve_terminal.py

与 serve_demo.py（web 版）共用同一份剧情：make_demo_runner 工厂产出思考/
分析/审批/总结的事件与文案，差别只在真执行入口（web 版查 REGISTRY，
终端版闭包持有 core）——两张动图的剧情因此永远对齐。构造方式与
tests/live/cli_driver.py 同款：两段 CliCore + TermFrontend，patch 点为
``openterminal.agent.runner.TaskRunner``（见 serve_demo.py 注记），
stdin/stdout 是调用方 pty 的 slave。
"""
from __future__ import annotations

import asyncio
import os
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

# 中性 shell 环境：公开动图不露真用户名/主机名（必须在 CliCore 起真 shell
# 前生效——LocalPtySession fork 继承本进程环境）。
os.environ["ZDOTDIR"] = str(pathlib.Path(__file__).resolve().parent / "zdot")

import openterminal.agent.runner as agent_runner_mod  # noqa: E402

from serve_demo import (  # noqa: E402  同目录脚本，sys.path[0] 即本目录
    DEMO_DIR,
    _seed_demo_dir,
    make_demo_runner,
)

from openterminal.config import Config  # noqa: E402
from openterminal.term_frontend import CliCore, TermFrontend  # noqa: E402


async def amain() -> None:
    _seed_demo_dir()
    # hook PS1 的 \w 展开工作目录：从演示目录起跑，提示符显示
    # /tmp/ot-demo 而非真实家目录结构（web 版同款顾虑，这里顺手消掉）
    os.chdir(DEMO_DIR)
    cfg = Config.load()
    core = CliCore(cfg, "local", frontend=None)
    agent_runner_mod.TaskRunner = make_demo_runner(lambda: core.backend)
    frontend = TermFrontend(core)
    core._frontend = frontend
    try:
        await frontend.run()
    finally:
        await core.close()


def main() -> None:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
