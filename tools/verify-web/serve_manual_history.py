"""真机验证：用户手动命令是否进**消息历史**、以及是否动了**系统提示词**。

模型边界截获每一次调用收到的系统提示词与消息列表，落 JSONL 供
verify-manual-history.cjs 断言。其余全真实：core 单管线、hook 上报、真 PTY、
WS、agent 真装配（含 ManualHistoryMiddleware）。

用法: python serve_manual_history.py --port 8271 --no-open
环境变量 OT_MANUAL_CAPTURE 指定截获文件（默认 .tmp/live/manual-history-capture.jsonl）
"""

from __future__ import annotations

import json
import os
import sys
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
for p in (REPO, os.path.join(REPO, "src")):
    if p not in sys.path:
        sys.path.insert(0, p)

from langchain_core.messages import (  # noqa: E402
    AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage,
)
from langchain_core.outputs import (  # noqa: E402
    ChatGeneration, ChatGenerationChunk, ChatResult,
)

import openterminal.core as core  # noqa: E402
from tests.fakes import FakeModel  # noqa: E402

CAPTURE = os.environ.get("OT_MANUAL_CAPTURE") or os.path.join(
    REPO, ".tmp", "live", "manual-history-capture.jsonl")

_CALLS = 0   # 模型桩是 pydantic 实例，计数放模块级


class CaptureModel(FakeModel):
    """每次模型调用都把「系统提示词 + 消息列表」追加到截获文件。

    不调工具、直接收尾——本验证只关心消息路由，不关心任务编排。
    """

    def __init__(self) -> None:
        super().__init__(messages=iter(()))
        os.makedirs(os.path.dirname(CAPTURE), exist_ok=True)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return ChatResult(generations=[ChatGeneration(
            message=self._reply(list(messages)))])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        msg = self._reply(list(messages))
        yield ChatGenerationChunk(message=AIMessageChunk(
            content=msg.content, id=msg.id or ("ai-" + uuid.uuid4().hex[:8])))

    def _reply(self, msgs):
        global _CALLS
        self._dump(msgs)
        # FakeModel 是 pydantic 模型，不许随便挂实例属性——用模块级计数器
        _CALLS += 1
        # ASCII 标记：驱动脚本要在 xterm 行里等它出现，别用 CJK 徒增变量
        return AIMessage(content=f"MODEL-REPLY-{_CALLS} done.",
                         id="ai-" + uuid.uuid4().hex[:8])

    def _dump(self, msgs) -> None:
        system = ""
        rows = []
        for m in msgs:
            kind = type(m).__name__
            content = m.content
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False, default=str)
            if isinstance(m, SystemMessage) or kind == "SystemMessage":
                system = content
            rows.append({"type": kind, "content": content})
        with open(CAPTURE, "a", encoding="utf-8") as f:
            f.write(json.dumps(
                {"system": system, "messages": rows}, ensure_ascii=False) + "\n")
        print(f"[capture] 系统提示词 {len(system)} 字，消息 {len(rows)} 条", flush=True)


def main() -> None:
    core.build_chat_model = lambda cfg: CaptureModel()
    print(f"[capture] 截获文件: {CAPTURE}", flush=True)
    from openterminal.app import main as app_main

    sys.argv = [sys.argv[0], "web"] + sys.argv[1:]
    app_main()


if __name__ == "__main__":
    main()
