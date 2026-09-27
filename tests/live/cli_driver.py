#!/usr/bin/env python
"""cli live 驱动：在进程内构造 CliCore + TermFrontend 跑单管线终端。

用法（被 tests/live/test_cli_live.py 经 PtyApp 以子进程 spawn，也可手动
在真终端里跑）::

    python tests/live/cli_driver.py --target local --scenario S [--text T]

- 目标 local：走真 LocalPtySession（pty.fork 用户默认 shell $SHELL -l）
  + 真 hook 注入（core._setup_interactive，与生产完全同路径）；
  stdin/stdout = 本进程继承的 pty slave（PtyApp 侧）。
- 不走 cli.py 菜单（菜单交互确定性差）：直接两段构造
  ``CliCore(cfg, target, frontend=None)`` + ``TermFrontend(core)`` +
  ``core._frontend = frontend`` + ``run()``（与 cli._run_pipeline 逐行等价）。
- ``--scenario`` 决定对 TaskRunner 的 ScriptedRunner 替换脚本
  （echo/approval/rescue/slow/none），替换点见下。

== Step 1 侦查结论（2026-09-27，HEAD de00737；ScriptedRunner 的事件契约权威） ==

1. **patch 点 = ``openterminal.agent.TaskRunner``**：core.py ``_run_task``
   函数体内 lazy import（``from .agent import TaskRunner``，core.py:1212），
   调用时才解析模块属性——monkeypatch ``openterminal.agent.TaskRunner``
   即可（test_web_worker._PatchBridge 同经验：patch 必须在 driver 进程，
   且要在第一条任务启动前打上）。
2. **事件对象 = ``openterminal.agent.TaskEvent``**（dataclass）：
   ``TaskEvent(kind, text="", command="", reasons=[])``。
3. **构造签名**（core.py:1247 实调用）::
       TaskRunner(self.agent, f"{tab_id}#c{ctx_epoch}",
                  max_tool_turns=cfg.shell.max_tool_turns, on_event=_live)
   ScriptedRunner.__init__ 必须接受这两个位置参数与两个关键字。
4. **_live(ev) 消费形态**（core.py:1228）：只转发 kind ∈ {token→ai_token,
   think→ai_think, denied, limit, error}，取 ``ev.text``；其余 kind 只进
   run() 返回列表。
5. **run(text) -> list[TaskEvent]**；核心 ``_handle_events``（core.py:1295）
   消费返回列表：``final`` → 发 final + ai_card 事件（CLI 总结框）；
   ``tool_call``/``denied`` → 仅 transcript 记账；``limit``/``error`` →
   提前收尾。列表处理完后看 ``runner.interrupt_payload``：非 None → 按
   ``["action_requests"]`` 逐个 ask_approval（决策 dict 形态
   ``{"type": "approve"}`` / ``{"type": "reject", "message": ...}``，来自
   前端 feed_msg(type="decision")）→ ``resume(decisions)`` 再跑一轮，直到
   interrupt_payload 为 None。
6. **token 计费属性**：``input_tokens/output_tokens/est_input_tokens/
   est_output_tokens``（全 0 → 无 usage 上报，状态行不显 token）。
7. **Ctrl+C 中断形态**：core._maybe_cancel_ai 直接 ``self._ai_task.cancel()``
   ——CancelledError 从 ScriptedRunner.run() 内部上抛即可（_ai_flow 捕获后
   发 error 事件「已停止」，前端红行收尾）。前端截获层在空闲态且
   ``core._ai_task`` 非 None 时把 \x03 转成 ClientMsg(type="interrupt")
   本地消费，不透传 PTY（test 7 的前提：ScriptedRunner 流式期间 _ai_task
   已置位——_start_ai 同步 create_task，task_start 事件先于首个 token）。
8. **rescue 触发现场**（core.py:_maybe_rescue）：用户命令经 hook 报 CMD、
   执行完 D 帧退出码非 0 且非 130/143、AI 空闲、无待决救援 → 发 rescue
   事件（line/ec/output）；决策经 ClientMsg(type="rescue", accept=bool)
   → ``_on_rescue_decision``：accept=True → ``_on_ai_line(prompt,
   hooked=True)`` → _start_ai → _run_task（hooked=True 跳过重注入）。
   注意真 shell 里 ``exit 3`` 会把登录 shell 本身退出（会话 EOF），救援
   场景用 ``sh -c 'exit 3'`` 触发同样的非零退出记账（行内仍含 "exit 3"）。
"""
from __future__ import annotations

import argparse
import asyncio
import os
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
for _p in (str(REPO / "src"), str(REPO)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO / ".env")   # 与 app.main 同序：仓库 .env → app_dir/.env
from openterminal.config import Config, app_dir  # noqa: E402

load_dotenv(app_dir() / ".env")

import openterminal.agent as agent_mod  # noqa: E402

from openterminal.agent import TaskEvent  # noqa: E402
from openterminal.term_frontend import CliCore, TermFrontend  # noqa: E402

TOUCH_TARGET = os.environ.get("OT_LIVE_TOUCH_TARGET",
                               "/tmp/ot_live_ok")   # 测试经 env 传 pid 隔离路径


def make_scripted_runner(scenario: str, core: "CliCore") -> type:
    """按场景生成 ScriptedRunner 类（闭包携带 scenario 与 core 引用——
    approval 场景决策放行后经 core.backend（InteractiveRunner，真注入
    通道）执行命令，与真 agent 的 execute 工具同一执行路径）。"""

    class ScriptedRunner:
        """事件形态与真实 TaskRunner 完全同形（见模块头侦查结论 1-6）。"""

        def __init__(self, agent, thread_id, max_tool_turns: int = 10, *,
                     on_event=None) -> None:
            self.agent = agent
            self.cfg = {"configurable": {"thread_id": thread_id}}
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
            if scenario == "echo":
                for tok in ("hello", " ", "world"):
                    self._emit("token", tok)
                    await asyncio.sleep(0.15)
                return [TaskEvent("final", text="hello world\n\n演示任务完成")]
            if scenario == "think":
                # 思考框 + 多行 token：钉死流式 \n 须翻 \r\n（raw 态无
                # ONLCR，裸 \n 会阶梯错位）——屏行起始列与框收底都在
                # test_ai_multiline_no_staircase 里断言
                self._emit("think", "先想想\n再想想")
                await asyncio.sleep(0.15)
                self._emit("token", "row1\nrow2\n| 1 | a | b |")
                await asyncio.sleep(0.15)
                return [TaskEvent("final", text="思考与多行流式收尾")]
            if scenario == "approval":
                # 一轮就挂起审批（真实链：HumanInTheLoopMiddleware 中断 →
                # interrupt_payload 暴露 action_requests）
                self.interrupt_payload = {"action_requests": [{
                    "args": {"command": f"touch {TOUCH_TARGET}"},
                    "description": "高危命令需要审批",
                }]}
                return []
            if scenario == "rescue":
                # 只服务救援 y 路径（n 路径不起任务）
                return [TaskEvent("final",
                                  text="RESCUE_ACCEPT_FINAL 失败原因已定位")]
            if scenario == "slow":
                # 长流：600 token × 0.2s ≈ 2 分钟，测试会在流中段 Ctrl+C
                for _ in range(600):
                    self._emit("token", "x")
                    await asyncio.sleep(0.2)
                return [TaskEvent("final", text="不应到达")]
            return []   # none：不发生（不 patch）

        async def resume(self, decisions: list[dict]) -> list[TaskEvent]:
            self.interrupt_payload = None   # 防核心重复进入审批循环
            d = decisions[0] if decisions else {}
            if d.get("type") != "approve":
                return []   # 拒绝：任务静默收尾（回执行由前端合成）
            # 真执行：经 PtyShellBackend.aexecute（deepagents execute 工具的
            # 同一入口——on_boundary 门闩 + on_start 执行面板回调 +
            # InteractiveRunner 真注入），不是旁路 subprocess
            await core.backend.aexecute(f"touch {TOUCH_TARGET}")
            return [TaskEvent("final", text="审批流程收尾完成")]   # 不含「已执行」：该词独占决策回执

    return ScriptedRunner


async def amain(args: argparse.Namespace) -> None:
    cfg = Config.load()
    core = CliCore(cfg, args.target, frontend=None)   # 两段构造（cli 同款）
    if args.scenario != "none":
        agent_mod.TaskRunner = make_scripted_runner(args.scenario, core)
    frontend = TermFrontend(core)
    core._frontend = frontend
    try:
        await frontend.run()
    finally:
        await core.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--target", default="local")
    ap.add_argument("--scenario", default="none",
                    choices=["echo", "think", "approval", "rescue", "slow",
                             "none"])
    ap.add_argument("--text", default="", help="预留（当前场景不消费）")
    args = ap.parse_args()
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
