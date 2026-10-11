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