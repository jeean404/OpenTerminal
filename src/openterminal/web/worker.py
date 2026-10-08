"""Web tab 适配器：PipelineCore 的 WebSocket 薄壳。

单管线核心（PTY 直通 + hook 记账 + AI 任务）在 openterminal.core；本模块
只负责：① emit_* 覆写为 outbox JSON 编码；② handle_client 别名（server.py
调用面不变）；③ 测试命名空间桥——tests/test_web_worker.py 历史上
monkeypatch 本模块的名字（wmod.open_session / SUBMIT_FALLBACK_DELAY /
CMDSET_* 等 28 处），实现搬去 core 后测试保持一行不改（阶段一验收硬线），
故把 patch 写入同步转发到 core，monkeypatch teardown 走同一通道还原。
"""
from __future__ import annotations

import sys

from .. import core as _core
from ..core import (  # noqa: F401 —— 再导出：测试 monkeypatch 命名空间
    PipelineCore, ServerMsg, ClientMsg, SUBMIT_FALLBACK_DELAY, _PROBE_TIMEOUT,
    CMDSET_ECHO_TIMEOUT, CMDSET_QUIET, CMDSET_PROMPT_TIMEOUT,
    CMDSET_RESUME_QUIET, build_agent, load_password, store_password,
    open_session, probe_profile,
)
# 阶段一验收硬线补充：tests/test_web_worker.py 还从本模块直名 import 这三个
# 名字（L340 _WebPresenter、L699/722/757 InteractiveRunner、L740
# CommandResult），实现搬去 core 后原样再导出，测试保持一行不改。
# _WebPresenter 为 CorePresenter 的旧名别名（core 内已按 plan Step 2 更名）。
from ..core import (  # noqa: F401
    CorePresenter as _WebPresenter, InteractiveRunner, CommandResult,
    CHANNEL_DEAD_EC, CHANNEL_DEAD_MSG,
)
from .protocol import encode_server


class TabWorker(PipelineCore):
    async def emit_msg(self, msg: ServerMsg) -> None:
        await self._outbox.put(("json", encode_server(msg)))

    async def emit_bytes(self, data: bytes) -> None:
        await self._outbox.put(("bytes", data))

    def _emit_nowait(self, msg: ServerMsg) -> None:
        self._outbox.put_nowait(("json", encode_server(msg)))

    async def handle_client(self, msg: ClientMsg) -> None:
        await self.feed_msg(msg)


class _PatchBridge(type(sys.modules[__name__])):
    def __setattr__(cls, name, value):
        super().__setattr__(name, value)
        # dunder 不转发：__doc__/__name__ 等模块属性两模块各持一份，
        # 单向桥会造成泄漏（pytest/monkeypatch 正常路径不会碰这些名字）
        if not name.startswith("__") and hasattr(_core, name):
            setattr(_core, name, value)


sys.modules[__name__].__class__ = _PatchBridge
