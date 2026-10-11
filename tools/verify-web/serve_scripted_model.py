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
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import (ChatGeneration, ChatGenerationChunk,
                                     ChatResult)

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
    # 复现「总结卡渲染后终端卡顿」现场：一次 execute + 一张高总结卡
    # （多行 markdown 表格 → pad 预留行最多，收束期补差链最长）
    "总结": {
        "calls": [
            ("execute", {"command": "uname -a && df -h"}),
        ],
        "final": "## 巡检结论\\n\\n"
                 "目标机巡检完成，磁盘与内核信息如下。\\n\\n"
                 "| 项目 | 值 | 状态 | 说明 |\\n"
                 "| --- | --- | --- | --- |\\n" +
                 "\\n".join(
                     f"| 检查项 {i} | 值 {i} | 正常 | 第 {i} 行占位，"
                     f"让总结卡足够高以复现收束期补差链 |" for i in range(1, 25)) +
                 "\\n\\n### 建议\\n\\n"
                 "1. 磁盘水位正常，无需扩容。\\n"
                 "2. 内核版本可接受。\\n"
                 "3. 继续保持每周巡检。",
    },
    # 复现「下载远端文件到本机」现场（2026-10-11 write_file ×失败）：
    # 第 1 轮 execute（真机上正是它把文件根打成远端 cwd）→ 第 2 轮 write_file
    "下载": {
        "rounds": [
            [("execute", {"command": "cat /tmp/smoke_print.sh"})],
            [("write_file", {"file_path": "/Downloads/smoke_print.sh",
                             "content": "#!/bin/bash\n# 测试脚本：打印 opentrimnal\n"
                                        "\necho \"opentrimnal\"\n"})],
        ],
        "final": "已下载到本机：Downloads/smoke_print.sh（真实路径见下）。",
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

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        # 真模型是流式分片到达；单块整条投递会让 final/ai_card 与 _mountCard
        # 撞出竞态（总结卡常丢，见 verify-card-dup 注释）。这里按行切分多片，
        # 让收束路径走真模型的时序。
        msg = self._reply(list(messages))
        mid = msg.id or ("ai-" + uuid.uuid4().hex[:8])
        calls = list(getattr(msg, "tool_calls", []) or [])
        text = msg.content if isinstance(msg.content, str) else str(msg.content or "")
        if not text:
            yield ChatGenerationChunk(message=AIMessageChunk(
                content="", tool_calls=calls, id=mid))
            return
        lines = text.split("\n")
        for i, ln in enumerate(lines):
            chunk = ln + ("\n" if i < len(lines) - 1 else "")
            if not chunk:
                continue
            yield ChatGenerationChunk(message=AIMessageChunk(
                content=chunk,
                tool_calls=(calls if i == 0 else None),
                id=mid if i == 0 else mid + "-" + str(i)))

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
        done = sum(1 for m in turn if isinstance(m, ToolMessage))
        rounds = sc.get("rounds")
        if rounds is not None:
            # 多轮脚本：第 N 轮发 rounds[N]，工具全部回来后收尾
            if done >= len(rounds):
                return AIMessage(content=sc["final"], id=mid)
            calls = [
                {"name": n, "args": a, "id": "tc-" + uuid.uuid4().hex[:8],
                 "type": "tool_call"}
                for n, a in rounds[done]
            ]
            return AIMessage(content="", id=mid, tool_calls=calls)
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
