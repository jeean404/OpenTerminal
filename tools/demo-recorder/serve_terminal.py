#!/usr/bin/env python3
"""终端 demo 录制服务：单管线 CLI + 脚本化 TaskRunner（无需模型网关）。

用法（被 record_terminal.py 经 pty.fork spawn，不直接手跑）::

    OPENTERMINAL_HOME=/tmp/ot-demo-home python tools/demo-recorder/serve_terminal.py

与 serve_demo.py（web 版）共用同一份剧情：导入其 DemoRunner 的思考/分析/
审批/总结文案与 DU_CMD，审批放行后经 core.backend.aexecute 真执行（与真
agent 的 execute 工具同一注入路径），总结表由真输出汇总——两版动图剧情
永远对齐。构造方式与 tests/live/cli_driver.py 同款：两段 CliCore +
TermFrontend，patch 点同为 ``openterminal.agent.TaskRunner``（lazy import
调用时才解析），stdin/stdout 是调用方 pty 的 slave。
"""
from __future__ import annotations

import asyncio
import os
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

# 中性 shell 环境：公开动图不露真用户名/主机名（必须在 CliCore 起真 zsh
# 前生效——LocalPtySession fork 继承本进程环境）。
os.environ["ZDOTDIR"] = str(pathlib.Path(__file__).resolve().parent / "zdot")

import openterminal.agent as agent_mod  # noqa: E402

from serve_demo import (  # noqa: E402  同目录脚本，sys.path[0] 即本目录
    ANALYSIS,
    DEMO_DIR,
    DU_CMD,
    THINK_LINES,
    _seed_demo_dir,
    _table_from,
)

from openterminal.agent import TaskEvent  # noqa: E402
from openterminal.config import Config  # noqa: E402
from openterminal.term_frontend import CliCore, TermFrontend  # noqa: E402


def make_demo_runner(core: "CliCore") -> type:
    """终端版 DemoRunner：事件契约与 serve_demo.DemoRunner 完全同形，
    差别只在 resume 的真执行入口——web 版走 REGISTRY[-1].backend，
    终端版走两段构造闭包里的 core.backend（InteractiveRunner 真注入，
    cli_driver approval 场景同路径）。"""

    class TerminalDemoRunner:
        def __init__(self, agent, thread_id, max_tool_turns: int = 10, *,
                     on_event=None) -> None:
            self.agent = agent
            self.max_tool_turns = max_tool_turns
            self.on_event = on_event
            self.interrupt_payload: dict | None = None
            self.input_tokens = 0
            self.output_tokens = 0
            self.est_input_tokens = 0
            self.est_output_tokens = 0

        def _emit(self, kind: str, text: str = "") -> None:
            if self.on_event is not None:
                self.on_event(TaskEvent(kind, text=text))

        async def run(self, text: str) -> list[TaskEvent]:
            for line in THINK_LINES:
                self._emit("think", line)
                await asyncio.sleep(0.55)
            await asyncio.sleep(0.4)
            for i in range(0, len(ANALYSIS), 6):
                self._emit("token", ANALYSIS[i:i + 6])
                await asyncio.sleep(0.04)
            await asyncio.sleep(0.9)
            self.interrupt_payload = {"action_requests": [{
                "args": {"command": DU_CMD},
                "description": "聚合 /tmp/ot-demo 一级目录占用（只读）",
            }]}
            return []

        async def resume(self, decisions: list[dict]) -> list[TaskEvent]:
            self.interrupt_payload = None
            d = decisions[0] if decisions else {}
            if d.get("type") != "approve":
                return []
            resp = await core.backend.aexecute(DU_CMD)
            await asyncio.sleep(0.6)
            return [TaskEvent("final", text=_table_from(getattr(resp, "output", "")))]

    return TerminalDemoRunner


async def amain() -> None:
    _seed_demo_dir()
    # hook PS1 的 %~ 展开 %HOME 相对路径：从演示目录起跑，提示符显示
    # /tmp/ot-demo 而非真实家目录结构（web 版同款顾虑，这里顺手消掉）
    os.chdir(DEMO_DIR)
    cfg = Config.load()
    core = CliCore(cfg, "local", frontend=None)
    agent_mod.TaskRunner = make_demo_runner(core)
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
