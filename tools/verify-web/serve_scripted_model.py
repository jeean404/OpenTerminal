"""以对话感知的脚本化模型启动 ot web —— docs/card_duplicate.md §5 真机验证专用。

模型边界可复现（脚本化 tool_calls），其余全真实：core 单管线、HITL 审批
（langchain HumanInTheLoopMiddleware）、WS、xterm 卡片层、PowerShell PTY。
monkeypatch 点是 core.build_chat_model 模块级占位（产品为测试桩预留的注入
点，见 core.py `_load_agent_stack` 注释）；build_agent 走真装配，真模型链路
（含 HITL after_model 回灌 AIMessage 的重吸收路径）完全保留。

场景按最后一条用户提问的关键词选（驱动 tools/verify-web/verify-card-dup.cjs
发对应 NL）：
  并行 → 一轮 2 个 execute（echo 重定向两个 TEMP 标记文件）
  单个 → 一轮 1 个 execute
  编辑 → 一轮 1 个 execute（命令留给用户在审批卡「修改」后改写）

用法: python serve_scripted_model.py --port 8251 --no-open
"""
from __future__ import annotations

import os
import sys
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
for p in (REPO, os.path.join(REPO, "src")):
    if p not in sys.path:
        sys.path.insert(0, p)

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

import openterminal.core as core
from tests.fakes import FakeModel

SCENARIOS = {
    "并行": {
        "calls": [
            ("execute", {"command": "echo aa | tee /tmp/ot-cc-aa.txt"}),
            ("execute", {"command": "echo bb | tee /tmp/ot-cc-bb.txt"}),
        ],
        "final": "并行写入完成：ot-cc-aa 与 ot-cc-bb 两个标记文件已生成。",
    },
    "单个": {
        "calls": [
            ("execute", {"command": "echo single | tee /tmp/ot-cc-single.txt"}),
        ],
        "final": "单个写入完成：ot-cc-single 标记文件已生成。",
    },
    "编辑": {
        "calls": [
            ("execute", {"command": "echo orig | tee /tmp/ot-cc-orig.txt"}),
        ],
        "final": "按编辑后的命令写入完成。",
    },
}
_DEFAULT = SCENARIOS["单个"]


class ScriptedFlowModel(FakeModel):
    """按「自最后一条用户消息以来有无 ToolMessage」区分工具轮/收尾轮。

    与 FakeModel 同基：bind_tools 自返回、_stream 整条单 chunk（langgraph
    messages 流式路径兼容，见 tests/fakes.py 注释）。消息 id 每次生成唯一，
    避免 add_messages 按 id 去重吞掉历史。
    """

    def __init__(self) -> None:
        super().__init__(messages=iter(()))

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return ChatResult(generations=[ChatGeneration(
            message=self._reply(list(messages)))])

    def _reply(self, msgs):
        turn: list = []
        last_user = ""
        for m in reversed(msgs):
            turn.append(m)
            if isinstance(m, HumanMessage):
                last_user = m.content if isinstance(m.content, str) else str(m.content)
                break
        sc = _scenario_for(last_user)
        mid = "ai-" + uuid.uuid4().hex[:8]
        if any(isinstance(m, ToolMessage) for m in turn):
            return AIMessage(content=sc["final"], id=mid)
        calls = [
            {"name": n, "args": a, "id": "tc-" + uuid.uuid4().hex[:8],
             "type": "tool_call"}
            for n, a in sc["calls"]
        ]
        return AIMessage(content="", id=mid, tool_calls=calls)


def _scenario_for(text: str) -> dict:
    for key, sc in SCENARIOS.items():
        if key in (text or ""):
            return sc
    return _DEFAULT


def main() -> None:
    core.build_chat_model = lambda cfg: ScriptedFlowModel()
    print("[scripted] build_chat_model 已接管为 ScriptedFlowModel", flush=True)
    from openterminal.app import main as app_main

    sys.argv = [sys.argv[0], "web"] + sys.argv[1:]
    app_main()


if __name__ == "__main__":
    main()
