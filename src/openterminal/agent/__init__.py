"""agent 域（阶段二 Task 14 重组；终审修复改惰性再导出）。

runner.py——LangGraph 智能体构建（build_agent/build_system_prompt）、
TaskRunner 任务执行与超时看护；backend.py——PtyShellBackend（PTY 桥接
deepagents 工具后端）；token_est.py——token 计数；sysprobe.py——
系统档案探测/缓存与手动预设。

__init__ 用 PEP 562 惰性转发旧 ``agent`` 模块全部公开名——不可急切
导入 runner：deepagents/langchain 导入约 4.6s，而 core/pipeline.py 模块级
``from ..agent.sysprobe import ...`` 必先执行本 __init__，急切导入会把
AI 栈拖进每次 CLI/Web 启动（击穿 _load_agent_stack 惰性机制）。

实现注记：转发必须经 importlib.import_module，不能 ``from . import
runner``——后者的 fromlist 处理对未知名会再触发本 __getattr__，
形成递归（PEP 562 已知坑）。
"""

from importlib import import_module
from typing import Any


def __getattr__(name: str) -> Any:
    runner = import_module(".runner", __name__)
    return getattr(runner, name)
