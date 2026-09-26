"""脚本化假模型：按预设消息序列响应。"""

from __future__ import annotations

from collections.abc import Iterator

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk


class FakeModel(GenericFakeChatModel):
    """GenericFakeChatModel 缺 bind_tools，deepagents 装配时会调用它。"""

    def bind_tools(self, tools, **kwargs):  # noqa: D102
        return self

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        # 偏离计划（最小，仅测试桩）：langchain_core 1.4.1 的
        # GenericFakeChatModel._stream 只会按空白切分 content，content 为空、
        # 仅带 tool_calls 的 AIMessage 一个 chunk 都不产出；而 langgraph 在
        # stream_mode 含 "messages" 时走流式路径调模型，空 chunk 流聚合时报
        # "No generations found in stream."。这里把整条脚本消息（保留
        # tool_calls）作为单个 chunk 产出；默认 _astream 会在线程里跑本方法。
        result = self._generate(
            messages, stop=stop, run_manager=run_manager, **kwargs
        )
        message = result.generations[0].message
        yield ChatGenerationChunk(message=AIMessageChunk(
            content=message.content,
            tool_calls=list(getattr(message, "tool_calls", [])),
            additional_kwargs=message.additional_kwargs,
            response_metadata=message.response_metadata,
            id=message.id,
        ))


def tool_call(name: str, args: dict, call_id: str = "tc1") -> AIMessage:
    return AIMessage(content="", tool_calls=[
        {"name": name, "args": args, "id": call_id, "type": "tool_call"}
    ])


def scripted(*messages: AIMessage) -> FakeModel:
    return FakeModel(messages=iter(messages))
