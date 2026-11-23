"""Web tab 适配器：PipelineCore 的 WebSocket 薄壳。

单管线核心（PTY 直通 + hook 记账 + AI 任务）在 openterminal.core；本模块
只负责：① emit_* 覆写为 outbox JSON 编码；② handle_client 别名（server.py
调用面不变）；③ 测试命名空间桥——tests/test_web_worker.py 历史上
monkeypatch 本模块的名字（wmod.open_session / SUBMIT_FALLBACK_DELAY /
CMDSET_* 等 28 处），实现搬去 core 后测试保持一行不改（阶段一验收硬线），
故把 patch 写入同步转发到 core，monkeypatch teardown 走同一通道还原。
"""
from __future__ import annotations

import asyncio
import base64
import json
import sys
from contextlib import suppress

from .. import core as _core  # noqa: F401 —— _PatchBridge 转发目标
# Task 9：改组件模块直连（不再经 core 包再导出）。测试 monkeypatch 打在
# wmod 的名字仍经 _PatchBridge → core._CoreBridge 二跳落到 pipeline 模块
# 字典，实现经 _impl.同名/模块全局读取——桥链语义不变。
from ..core.cmdset_runner import (  # noqa: F401 —— 测试 monkeypatch 命名空间
    CMDSET_ECHO_TIMEOUT, CMDSET_QUIET, CMDSET_PROMPT_TIMEOUT,
    CMDSET_RESUME_QUIET,
)
from ..core.messages import (  # noqa: F401
    CHANNEL_DEAD_EC, CHANNEL_DEAD_MSG, ClientMsg, CommandResult,
    InteractiveRunner, ServerMsg,
)
# _WebPresenter 为 CorePresenter 的旧名别名（tests/test_web_worker.py 直名
# import L340；InteractiveRunner/CommandResult 直名 import L699/722/740/757）。
from ..core.pipeline import (  # noqa: F401
    CorePresenter as _WebPresenter, PipelineCore, SUBMIT_FALLBACK_DELAY,
    _PROBE_TIMEOUT, build_agent, build_chat_model, load_password, probe_profile,
    store_password,
)
from ..connections import open_session  # noqa: F401
from .protocol import encode_server


class TabWorker(PipelineCore):
    paced_display = True   # Web：AI 文本攒到段边界一次性下发（ai_result）+ 心跳

    def enable_history(self, target, *, resume_id: str | None = None) -> None:
        from ..core.conversation_history import ConversationHistory, connection_key

        self._history = ConversationHistory()
        self._history_target_key = connection_key(self.target_name, target)
        self._history_resume_id = resume_id
        self._history_conversation_id = None
        self._history_restore_loaded = False
        self._last_completed_values = None
        self._history_manual_sections: list[str] = []
        self._history_base_manual_sections: list[str] = []
        self._pending_history_manual: list[str] = []
        self._history_ui_frames: list[dict] = []

    def _record_history_frame(self, frame: str | bytes) -> None:
        if getattr(self, "_history_conversation_id", None) is None:
            return
        frames = self._history_ui_frames
        if isinstance(frame, bytes):
            frames.append({
                "kind": "bytes",
                "data": base64.b64encode(frame).decode("ascii"),
            })
        else:
            try:
                message = json.loads(frame)
            except (TypeError, ValueError):
                return
            if message.get("type") == "approval":
                return
            frames.append({"kind": "json", "data": message})

    async def emit_msg(self, msg: ServerMsg) -> None:
        encoded = encode_server(msg)
        self._record_history_frame(encoded)
        await self._outbox.put(("json", encoded))

    async def emit_bytes(self, data: bytes) -> None:
        self._record_history_frame(data)
        await self._outbox.put(("bytes", data))

    def _emit_nowait(self, msg: ServerMsg) -> None:
        encoded = encode_server(msg)
        self._record_history_frame(encoded)
        self._outbox.put_nowait(("json", encoded))

    async def handle_client(self, msg: ClientMsg) -> None:
        await self.feed_msg(msg)

    async def close(self) -> None:
        history = getattr(self, "_history", None)
        task = self._ai_task
        try:
            await super().close()
        finally:
            if task is not None and task is not asyncio.current_task():
                with suppress(asyncio.CancelledError):
                    await task
            conversation_id = getattr(self, "_history_conversation_id", None)
            if history is not None and conversation_id is not None:
                await asyncio.to_thread(
                    history.save_ui_frames, conversation_id,
                    list(self._history_ui_frames))


class _PatchBridge(type(sys.modules[__name__])):
    def __setattr__(cls, name, value):
        super().__setattr__(name, value)
        # dunder 不转发：__doc__/__name__ 等模块属性两模块各持一份，
        # 单向桥会造成泄漏（pytest/monkeypatch 正常路径不会碰这些名字）
        if not name.startswith("__") and hasattr(_core, name):
            setattr(_core, name, value)


sys.modules[__name__].__class__ = _PatchBridge
