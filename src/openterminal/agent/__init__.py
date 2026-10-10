"""agent 域（阶段二 Task 14 重组）。

runner.py——LangGraph 智能体构建（build_agent/build_system_prompt）、
TaskRunner 任务执行与超时看护；backend.py——PtyShellBackend（PTY 桥接
deepagents 工具后端）；token_est.py——token 计数；sysprobe.py——
系统档案探测/缓存与手动预设。
本 __init__ 再导出旧 ``agent`` 模块全部公开名，旧 import 路径
（``from openterminal.agent import TaskRunner`` 等）不因拆包而变。
"""

from .runner import (  # noqa: F401
    AGENT_STALL_TIMEOUT, AGENT_TOOL_TIMEOUT, DenyMiddleware, TaskEvent,
    TaskRunner, _split_content, _tool_args_summary, _with_skills,
    build_agent, build_chat_model, build_system_prompt, message_text,
    thinking_text,
)
