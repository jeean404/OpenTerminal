"""agent 装配：组件黏合成可执行的 LangGraph 智能体（从 runner.py 拆出）。

build_agent 编排 prompt/model/middleware/backend → create_deep_agent；
_with_skills 给文件后端挂代理 Skills。只在真正构建 agent 时 import。
"""

from __future__ import annotations

from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend
from langchain.agents.middleware import (
    HumanInTheLoopMiddleware,
    ModelRetryMiddleware,
    TodoListMiddleware,
)
from langgraph.checkpoint.memory import MemorySaver

from ..config import Config
from ..policy import Policy
from ..skills import skill_routes, skill_sources
from ..skills.gating import GatedSkillsMiddleware
from .backend import PtyShellBackend
from .middleware import DenyMiddleware, ManualHistoryMiddleware, ToolErrorRetryMiddleware
from .model import build_chat_model
from .prompt import build_system_prompt
from .sysprobe import SystemProfile


def build_agent(
    profile: SystemProfile,
    session,
    cfg: Config,
    policy: Policy | None = None,
    *,
    model: Any = None,
    remote_target: bool = False,
    tools: list | None = None,
    manual_history: Any = None,
):
    """返回 (compiled_agent, session_allowed_commands)。

    remote_target：目标是 SSH/远端 shell——此时 session.cwd 是远端路径，不能当
    本机文件根（见 backend._local_root），文件工具回退到用户主目录。

    tools：MCP 等外部工具（见 agent/mcp.gather_mcp_tools）。工具发现是异步的，
    故由调用方在建 agent 前拉好传进来——本函数保持同步，仍在 to_thread 里跑。
    """
    policy = policy or Policy(
        mode=cfg.policy.mode,
        auto_extra=cfg.policy.auto_extra,
        approve_extra=cfg.policy.approve_extra,
        deny_extra=cfg.policy.deny_extra,
    )
    allowed: set[str] = set()
    backend = PtyShellBackend(session, remote_target=remote_target)

    def _when(req) -> bool:
        cmd = req.tool_call.get("args", {}).get("command", "")
        return policy.needs_approval(cmd, allowed)

    def _description(tc, state, runtime) -> str:
        cmd = tc.get("args", {}).get("command", "")
        reasons = "；".join(policy.classify(cmd).reasons) or "高危命令"
        return f"高危命令需要审批\n\n目标主机：{profile.host}\n风险点：{reasons}\n命令：{cmd}"

    middleware = [
        # 最外层：任何工具链异常先在这里收口成 ToolMessage，不再打死任务
        ToolErrorRetryMiddleware(max_retries=3),
        DenyMiddleware(policy),
        # 复杂多步任务的待办清单：提供 write_todos 工具 + 「何时该用」的提示词。
        # deepagents 默认工具面（ls/read_file/.../execute/task）里没有待办工具，
        # 不挂它模型就没有可调的工具，前端自然也长不出待办卡。
        TodoListMiddleware(),
    ]

    def _model_failure(exc: Exception) -> str:
        # on_failure 只拿到异常；文案对齐「任务失败」口径，成为最终回复
        return (f"任务失败：模型调用重试 3 次仍未成功"
                f"（{type(exc).__name__}: {exc}）。"
                f"请稍后重试；若持续失败请检查模型网关配置。")

    # 模型 API 侧（网关抖动/限流/超时）独立重试，不与工具层重试混计
    middleware.append(ModelRetryMiddleware(
        max_retries=3, on_failure=_model_failure,
    ))
    middleware.append(HumanInTheLoopMiddleware(interrupt_on={"execute": {
        "allowed_decisions": ["approve", "edit", "reject"],
        "when": _when,
        "description": _description,
    }}))
    # 用户手动敲的命令不在消息历史里：由这个中间件按增量并进末条消息，
    # 模型才知道「刚才发生了什么」（见 core/manual_history.py 的分层）
    if manual_history is not None:
        middleware.append(ManualHistoryMiddleware(manual_history))

    agent = create_deep_agent(
        model=model or build_chat_model(cfg.model),
        # MCP 工具是加性的，不会顶掉内置的 ls/read_file/execute 等
        tools=tools or [],
        backend=_with_skills(backend, middleware),
        # 本机文件根一并告知模型：虚拟路径落地在本机哪里必须能向用户交代，
        # 否则「下载到我本机」写完只报 /x，用户在磁盘上找不到文件
        system_prompt=build_system_prompt(profile, str(backend.cwd)),
        middleware=middleware,
        checkpointer=MemorySaver(),
    )
    return agent, allowed, backend


def _with_skills(backend: PtyShellBackend, middleware: list):
    """给 agent 挂上内置/用户两层 Agent Skills（渐进式披露）。

    skill 目录在文件沙箱（shell cwd）之外，故经 CompositeBackend 以
    /skills/... 虚拟前缀挂进文件系统：GatedSkillsMiddleware 把 skill 清单
    注入系统提示词（停用的 skill 被过滤掉，见 skills/gating.py），模型按需 read_file 加载 SKILL.md 全文；用户目录
    后挂，同名 skill 覆盖内置。backend 本身原样返回给调用方（回调、
    cwd 语义不变），composite 只作为 agent 的文件/命令入口。
    """
    routes = skill_routes()
    if not routes:
        return backend
    agent_backend: Any = CompositeBackend(
        default=backend,
        routes={p: FilesystemBackend(root_dir=str(d)) for p, d in routes.items()},
    )
    middleware.append(
        GatedSkillsMiddleware(backend=agent_backend, sources=skill_sources())
    )
    return agent_backend