"""agent 中间件：审批/拒绝（DenyMiddleware）与异常重试（ToolErrorRetryMiddleware）。

从 runner.py 拆出（一事一文件）。两类都做 wrap_tool_call 包装，挂进
create_deep_agent 的工具链；纯工具层逻辑，不依赖任务执行。
"""

from __future__ import annotations

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphBubbleUp

from ..policy import Policy


class DenyMiddleware(AgentMiddleware):
    """灾难命令：不执行，直接把拒绝原因作为 tool 错误回模型。"""

    def __init__(self, policy: Policy) -> None:
        self.policy = policy

    async def awrap_tool_call(self, request, handler):
        tc = request.tool_call
        if tc.get("name") == "execute":
            cmd = tc.get("args", {}).get("command", "")
            d = self.policy.classify(cmd)
            if d.level == "deny":
                return ToolMessage(
                    content=f"命令被 OpenTerminal 安全策略拒绝：{cmd}\n原因："
                            f"{'；'.join(d.reasons)}。请换一个方案，不要换皮重试。",
                    tool_call_id=tc["id"],
                    status="error",
                )
        return await handler(request)


class ToolErrorRetryMiddleware(AgentMiddleware):
    """工具执行异常→错误 ToolMessage 回模型重试；用尽后宣告任务失败让模型总结。

    约定（产品诉求）：异常不得直接打死任务。前 max_retries 次失败把异常
    信息交给模型，由它换方案重试；第 max_retries+1 次失败返回「任务失败」
    并要求模型停止调用工具、总结失败原因。langgraph 控制流（HITL 中断等）
    原样上抛，不吞。
    """

    def __init__(self, max_retries: int = 3) -> None:
        self.max_retries = max_retries
        self._failures = 0
        self._gave_up = False

    def before_agent(self, state, runtime) -> dict | None:
        # 计数按任务（一次 run/resume 驱动）清零，跨任务不累积
        self._failures = 0
        self._gave_up = False
        return None

    async def abefore_agent(self, state, runtime) -> dict | None:
        self._failures = 0
        self._gave_up = False
        return None

    def _reject(self, tc: dict) -> ToolMessage:
        return ToolMessage(
            content="任务失败：重试次数已用尽。请勿再调用工具，"
                    "直接向用户总结失败原因（已尝试的操作、错误信息和建议）。",
            tool_call_id=tc["id"],
            name=tc.get("name", "tool"),
            status="error",
        )

    def _feedback(self, tc: dict, exc: Exception) -> ToolMessage:
        name = tc.get("name", "tool")
        self._failures += 1
        detail = f"{type(exc).__name__}: {exc}"
        if self._failures <= self.max_retries:
            content = (
                f"工具 {name} 执行出错（第 {self._failures}/{self.max_retries} 次失败）："
                f"{detail}\n请根据错误信息调整参数或换一种方案后重试。"
            )
        else:
            self._gave_up = True
            content = (
                f"任务失败：已重试 {self.max_retries} 次仍无法完成，不再重试。\n"
                f"最后一次错误：{detail}\n"
                f"请停止尝试，向用户总结失败原因（已尝试的操作、错误信息和建议）。"
            )
        return ToolMessage(
            content=content, tool_call_id=tc["id"], name=name, status="error",
        )

    def wrap_tool_call(self, request, handler):
        tc = request.tool_call
        if self._gave_up:
            return self._reject(tc)
        try:
            return handler(request)
        except GraphBubbleUp:
            raise
        except Exception as e:  # noqa: BLE001 - 异常转 tool 错误回模型
            return self._feedback(tc, e)

    async def awrap_tool_call(self, request, handler):
        tc = request.tool_call
        if self._gave_up:
            return self._reject(tc)
        try:
            return await handler(request)
        except GraphBubbleUp:
            raise
        except Exception as e:  # noqa: BLE001 - 异常转 tool 错误回模型
            return self._feedback(tc, e)


def _augment_message(message, section: str):
    """把一段文本并到消息正文末尾（不动消息类型与工具调用形状）。"""
    content = message.content
    if isinstance(content, str):
        new = (content + "\n\n" if content else "") + section
    elif isinstance(content, list):
        new = list(content) + [{"type": "text", "text": "\n\n" + section}]
    else:
        new = section
    try:
        return message.model_copy(update={"content": new})
    except Exception:  # noqa: BLE001 - 拷不动就原样返回，宁可少送也别送坏
        return message


class ManualHistoryMiddleware(AgentMiddleware):
    """把「用户手动敲过的命令」并进消息历史，让模型有现场感。

    用户自己在终端敲的命令不在 agent 的消息历史里（_run_task 只把自然语言
    原文交给 TaskRunner），模型因此不知道刚才发生了什么。全塞进上下文又太
    占，所以走中间件，三条性质正好对上：

    - **进消息历史，不是系统提示词**。系统提示词一换就作废整段前缀缓存；
      改写末条消息则前面照旧命中缓存。这是走消息历史最大的好处。
    - **并进最近一条消息**：本轮模型看到的是「用户的话 + 这期间他手动敲了
      什么」，语义上就是同一次交待，不必让模型去对两条独立消息。
    - **增量**（provider 只给没送过的）：同一段命令不会一轮轮重复，上下文
      只随新命令增长，正好压住「全塞会占上下文」那条。

    provider 是可调用（返回 str，空串=没有新东西→原样返回 request），或一个
    带 `take_new()` 的对象（core 侧的 ManualHistory）。两种都收，免得调用方
    传错形态就静默不工作。agent 层不 import core，便于单测。
    """

    def __init__(self, provider) -> None:
        # 对象形态统一折成 callable：传错成对象也不至于一个字都不注入
        self._provider = getattr(provider, "take_new", provider)

    def modify_request(self, request):
        if not self._provider:
            return request
        try:
            section = self._provider()
        except Exception:  # noqa: BLE001 - 摘要是加分项，绝不挡住模型调用
            return request
        if not section:
            return request
        messages = list(request.messages)
        if not messages:
            from langchain_core.messages import HumanMessage

            messages.append(HumanMessage(content=section))
        else:
            messages[-1] = _augment_message(messages[-1], section)
        return request.override(messages=messages)

    # 框架入口是 wrap_model_call（modify_request 只是我们的辅助函数，没人替
    # 我们调）——只实现后者等于什么都没挂上，实测踩过。
    def wrap_model_call(self, request, handler):
        return handler(self.modify_request(request))

    async def awrap_model_call(self, request, handler):
        return await handler(self.modify_request(request))