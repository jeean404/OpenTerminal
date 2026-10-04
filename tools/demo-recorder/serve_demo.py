#!/usr/bin/env python3
"""demo 录制服务：ot web + 脚本化 TaskRunner（无需模型网关，剧情确定可重录）。

用法::

    OPENTERMINAL_HOME=/tmp/ot-demo-home \\
        python tools/demo-recorder/serve_demo.py --port 8099

剧情（DemoRunner）：思考流 → 分析卡流式 → 审批面板(du 聚合) → 点执行后
经 core.backend.aexecute 真执行（与真 agent 的 execute 工具同一路径，
终端 pane 原地出输出）→ 总结卡 markdown 表格（行来自真 du 输出，内外一致）。

patch 点与 tests/live/cli_driver.py 同源结论：core._run_task 函数体内
lazy import ``from .agent import TaskRunner``，调用时才解析模块属性——
monkeypatch ``openterminal.agent.TaskRunner`` 对 web 路径同样生效。
TabWorker 包一层只为把实例登记进 REGISTRY（resume 要拿 core.backend）。
"""
from __future__ import annotations

import argparse
import asyncio
import os
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

import openterminal.agent as agent_mod  # noqa: E402
from openterminal.agent import TaskEvent  # noqa: E402
from openterminal.config import Config  # noqa: E402
import openterminal.web.server as web_server  # noqa: E402

REGISTRY: list = []
_OrigTabWorker = web_server.TabWorker


class _DemoTabWorker(_OrigTabWorker):
    def __init__(self, *a, **k) -> None:
        super().__init__(*a, **k)
        REGISTRY.append(self)


web_server.TabWorker = _DemoTabWorker

DU_CMD = "du -sh /tmp/ot-demo/* 2>/dev/null | sort -rh | head -6"

THINK_LINES = (
    "要 /tmp/ot-demo 的容量表：du 聚合一级子目录就够，不必逐文件扫。",
    "读只聚合、秒级完成；演示里走一次审批面板展示闸门长相。",
)
ANALYSIS = (
    "我会用 `du -sh` 聚合 /tmp/ot-demo 下每个一级目录的大小，按占用降序取前几行，"
    "汇总成一张 markdown 表给你。\n"
    "命令是只读聚合，不改动任何文件；执行完我直接读输出成表。"
)

DEMO_DIR = pathlib.Path("/tmp/ot-demo")


def _seed_demo_dir() -> None:
    """中性演示数据（公开动图不露本机 /tmp 真实内容）；已种过则跳过。"""
    import shutil
    if (DEMO_DIR / ".seeded").exists():
        return
    shutil.rmtree(DEMO_DIR, ignore_errors=True)
    chunk = b"\0" * (1024 * 1024)
    for name, mb in (("video-exports", 81), ("build-cache", 36),
                     ("datasets", 12), ("logs", 4)):
        d = DEMO_DIR / name
        d.mkdir(parents=True)
        with open(d / "part.bin", "wb") as f:
            for _ in range(mb):
                f.write(chunk)
    notes = DEMO_DIR / "notes"
    notes.mkdir(parents=True)
    (notes / "todo.txt").write_text("剪辑顺序待排\n字幕待校\n", encoding="utf-8")
    (DEMO_DIR / "README.md").write_text("# ot-demo\n演示数据目录。\n", encoding="utf-8")
    (DEMO_DIR / ".seeded").write_text("ok\n", encoding="utf-8")


class DemoRunner:
    """事件形态与真实 TaskRunner 同形（kind/text/interrupt_payload/resume）。"""

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
        core = REGISTRY[-1]
        resp = await core.backend.aexecute(DU_CMD)
        await asyncio.sleep(0.6)
        return [TaskEvent("final", text=_table_from(getattr(resp, "output", "")))]


def _table_from(output: str) -> str:
    rows = []
    for line in (output or "").splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2 and parts[0].strip():
            rows.append((parts[0].strip(), parts[1].strip()))
    if not rows:
        return "/tmp/ot-demo 目前是空的——没有可聚合的目录。"
    body = "\n".join(f"| `{p}` | {s} |" for s, p in rows)
    return (f"聚合完成，/tmp/ot-demo 下占用前 {len(rows)} 名：\n\n"
            f"| 目录 | 大小 |\n|---|---|\n{body}\n\n"
            f"首行就是大头；要清理告诉我留哪些，我来出命令。")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8099)
    args = ap.parse_args()
    # 中性 shell 环境：公开动图不露真用户名/主机名，空 rc 也让 local tab 秒连
    os.environ["ZDOTDIR"] = str(pathlib.Path(__file__).resolve().parent / "zdot")
    _seed_demo_dir()
    agent_mod.TaskRunner = DemoRunner
    cfg = Config.load()
    web_server.run_web(cfg, ["--port", str(args.port), "--no-open"])


if __name__ == "__main__":
    main()
