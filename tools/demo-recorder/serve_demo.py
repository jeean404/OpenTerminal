#!/usr/bin/env python3
"""demo 录制服务：ot web + 脚本化 TaskRunner（无需模型网关，剧情确定可重录）。

用法::

    OPENTERMINAL_HOME=/tmp/ot-demo-home \\
        python tools/demo-recorder/serve_demo.py --port 8099

剧情（DemoRunner，与 README 头图六步一一对应）::

    ls /tmp/ot-demo            ① 普通命令，真 shell 彩色输出
    看看 /tmp/ot-demo 下哪些目录最占空间，清掉 build-cache，给我一张表
                             ② 自然语言任务
    think ×2                   ③ 思考流
    token 流式分析             ④ 分析卡流式成型
    tool_start(du)             只读探查：策略 auto，命令卡不长审批按钮
                               ——「看一眼不花钱」这半句是真演出来的
    tool_start(rm -rf …)       ⑤ 改动磁盘：策略 approve + 高危，命令卡
                               长出 执行/修改/拒绝/始终允许，等审批
    点「执行」→「确认执行」    ⑥ 高危二次确认后真执行（core.backend.aexecute，
                               与真 agent 的 execute 工具同一注入路径）
    final 总结卡               markdown 表格行来自真 du 输出，内外一致

patch 点 = ``openterminal.agent.runner.TaskRunner``（2026-10-25 复核）：
ai_flow 的调用点是函数体内的 ``from ..agent.runner import TaskRunner``，
每次任务重解析模块属性——打 ``openterminal.agent.TaskRunner`` 只改了包
的惰性转发槽，调用点根本不看它，剧情会整个滑回真模型（实测：模型重试
3 次 AnthropicConnectionError）。必须落到 runner 模块自身。
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

import openterminal.agent.runner as agent_runner_mod  # noqa: E402
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
CLEAN_TARGET = "/tmp/ot-demo/build-cache"
RM_CMD = f"rm -rf {CLEAN_TARGET}"

# 两行会被思考块连成一段再按终端列宽折行：压到 100 列内不折断英文词
#（旧文案「清 build-cache」在 100 列上断成 build-cach/e）
THINK_LINES = (
    "要 /tmp/ot-demo 的容量表：du 聚合一级子目录就够。",
    "查占用只读直接跑；删目录要你点头。",
)
ANALYSIS = (
    "我先用 `du -sh` 聚合 /tmp/ot-demo 下每个一级目录的大小，按占用降序取前几行。\n"
    "查占用是只读的，我自己跑；`build-cache` 是能再生的缓存，清掉它腾空间。\n"
    "但删目录会改动磁盘——我先把命令摆进审批面板，你点了才执行，最后汇总成表。"
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


def _parse_du(output: str) -> list[tuple[str, str]]:
    """du -sh 输出 → [(绝对路径, 大小)]，按 du 给出的降序保持。"""
    rows = []
    for line in (output or "").splitlines():
        size, _, path = line.partition("\t")
        if path.strip() and size.strip():
            rows.append((path.strip(), size.strip()))
    return rows


def _table_from(output: str) -> str:
    """纯 du 输出成表（终端版收尾沿用；web 版走 _summary_from）。"""
    rows = _parse_du(output)
    if not rows:
        return "/tmp/ot-demo 目前是空的——没有可聚合的目录。"
    body = "\n".join(f"| `{p}` | {s} |" for p, s in rows)
    return (f"聚合完成，/tmp/ot-demo 下占用前 {len(rows)} 名：\n\n"
            f"| 目录 | 大小 |\n|---|---|\n{body}\n\n"
            f"首行就是大头；要清理告诉我留哪些，我来出命令。")


def _summary_from(before: str, removed: str) -> str:
    """删除后的收束表：腾出多少 + 剩余占用（行全部来自真 du 输出）。"""
    rows = _parse_du(before)
    if not rows:
        return "/tmp/ot-demo 目前是空的——没有可聚合的目录。"
    freed = next((s for p, s in rows if p == removed), "")
    rest = [(p, s) for p, s in rows if p != removed]
    head = f"已清掉 `{removed}`" + (f"，腾出 {freed}。" if freed else "。")
    if not rest:
        return head + "\n\n/tmp/ot-demo 下没有别的目录了。"
    body = "\n".join(f"| `{p}` | {s} |" for p, s in rest)
    return (f"{head}剩余占用：\n\n"
            f"| 目录 | 大小 |\n|---|---|\n{body}\n\n"
            f"还想清别的告诉我目标，我来出命令。")


def make_demo_runner(backend_of):
    """剧情 Runner 工厂。``backend_of()`` 给出真执行入口——web 版查
    REGISTRY，终端版闭包持有 core。两版共用本工厂，两张动图的剧情因此
    永远对齐（demo-recorder/README 的硬约定）。

    事件形态与真实 TaskRunner 同形：kind/text/command/name/index/failed +
    interrupt_payload + resume + claim_seq。**tool_start 必须发**：paced
    显示下 token 攒在段缓冲里，_live 只在 tool_start 调 _flush_seg 落格成
    分析卡——旧剧情只发 think/token 就要审批，分析卡永远不出（2026-10-25
    真机复现）。审批按钮也靠 claim_seq 认领这张命令卡，否则回落模态。
    """

    class DemoRunner:
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
            self._tool_seq = 0
            self._claims: dict[tuple[str, str], list[int]] = {}
            self._before_output = ""
            self._rm_index = 0

        def _emit(self, kind: str, text: str = "", **kw) -> None:
            if self.on_event is not None:
                self.on_event(TaskEvent(kind, text=text, **kw))

        def _announce(self, events: list, ev: TaskEvent) -> None:
            """真实 TaskRunner._add 同款：既进返回列表，又实时投递展示层。"""
            events.append(ev)
            if self.on_event is not None:
                self.on_event(ev)

        def claim_seq(self, name: str, command: str):
            """审批认领表（真实 TaskRunner 同名接口，ai_flow 无条件调）：
            (name, command) 按宣告序弹 index，好让审批按钮摆回同一张命令卡。"""
            q = self._claims.get((name, command))
            return q.pop(0) if q else None

        async def run(self, text: str) -> list[TaskEvent]:
            events: list[TaskEvent] = []
            for line in THINK_LINES:
                self._announce(events, TaskEvent("think", text=line))
                await asyncio.sleep(0.55)
            await asyncio.sleep(0.4)
            for i in range(0, len(ANALYSIS), 6):
                self._announce(events, TaskEvent("token", text=ANALYSIS[i:i + 6]))
                await asyncio.sleep(0.04)
            await asyncio.sleep(0.9)

            # ① 只读探查：策略 auto → 命令卡不长审批按钮，输出原地落终端
            self._tool_seq += 1
            i_du = self._tool_seq
            self._claims.setdefault(("execute", DU_CMD), []).append(i_du)
            self._announce(events, TaskEvent("tool_call", command=DU_CMD))
            self._announce(events, TaskEvent(
                "tool_start", name="execute", command=DU_CMD,
                text=DU_CMD[:120], index=i_du))
            resp = await backend_of().aexecute(DU_CMD)
            self._before_output = getattr(resp, "output", "") or ""
            self._announce(events, TaskEvent(
                "tool_end", name="execute", index=i_du, command=DU_CMD))
            await asyncio.sleep(0.8)

            # ② 改动磁盘：策略 approve + 高危 → 卡上长 执行/修改/拒绝/始终允许
            self._tool_seq += 1
            i_rm = self._tool_seq
            self._rm_index = i_rm
            self._claims.setdefault(("execute", RM_CMD), []).append(i_rm)
            self._announce(events, TaskEvent("tool_call", command=RM_CMD))
            self._announce(events, TaskEvent(
                "tool_start", name="execute", command=RM_CMD,
                text=RM_CMD[:120], index=i_rm))
            self.interrupt_payload = {"action_requests": [{
                "args": {"command": RM_CMD},
                "description": f"删除缓存目录 {CLEAN_TARGET}，腾出磁盘空间",
            }]}
            return events

        async def resume(self, decisions: list[dict]) -> list[TaskEvent]:
            self.interrupt_payload = None
            d = decisions[0] if decisions else {}
            if d.get("type") != "approve":
                return []
            events: list[TaskEvent] = []
            await backend_of().aexecute(RM_CMD)
            self._announce(events, TaskEvent(
                "tool_end", name="execute", index=self._rm_index, command=RM_CMD))
            await asyncio.sleep(0.7)
            events.append(TaskEvent(
                "final", text=_summary_from(self._before_output, CLEAN_TARGET)))
            return events

    return DemoRunner


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8099)
    args = ap.parse_args()
    # 中性 shell 环境：公开动图不露真用户名/主机名，空 rc 也让 local tab 秒连
    os.environ["ZDOTDIR"] = str(pathlib.Path(__file__).resolve().parent / "zdot")
    _seed_demo_dir()
    agent_runner_mod.TaskRunner = make_demo_runner(lambda: REGISTRY[-1].backend)
    cfg = Config.load()
    web_server.run_web(cfg, ["--port", str(args.port), "--no-open"])


if __name__ == "__main__":
    main()
