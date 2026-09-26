"""甄别用户输入：自然语言任务 vs 直接 shell 命令。

单管线（设计文档 §5.1）：命令执行成为 AI 的子能力（agent 经 ``__ot_exec__``
在同一 PTY 执行），分类错误的代价降为「多跑一次 LLM / 多一步代执行」——
误判双向无损。因此启发式全删，只保留 hook 前缀判定（``?`` → AI、``/`` →
斜杠命令、``!`` → 强制命令）+ 单次 LLM 兜底。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal

Intent = Literal["task", "command"]


class IntentClassifier:
    def __init__(
        self,
        llm_classify: Callable[[str], Awaitable[Intent]] | None = None,
    ) -> None:
        self._llm = llm_classify

    async def classify(self, text: str) -> Intent:
        text = text.strip()
        if not text:
            return "task"
        if text.startswith("!"):
            return "command"      # 强制命令
        if text.startswith("?"):
            return "task"         # 强制 AI
        if text.startswith("/"):
            return "task"         # 斜杠命令：worker 拦截，不进 LLM
        if self._llm is not None:
            try:
                return await self._llm(text)
            except Exception:    # noqa: BLE001 - LLM 失败按自然语言处理
                return "task"
        return "task"
