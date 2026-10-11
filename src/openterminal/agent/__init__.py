"""agent 域（阶段二 Task 14 重组；终审修复改惰性再导出）。

runner.py——TaskRunner 任务执行与超时看护；build.py——智能体组装
（build_agent/_with_skills）；middleware.py——审批/拒绝与异常重试中间件；
prompt.py——系统提示词；model.py——聊天模型工厂；backend.py——
PtyShellBackend（PTY 桥接 deepagents 工具后端）；token_est.py——token
计数；sysprobe.py——系统档案探测/缓存与手动预设。

__init__ 用 PEP 562 惰性转发旧 ``agent`` 模块全部公开名——按名字路由到
所属子模块，且不可急切导入 runner：deepagents/langchain 导入约 4.6s，
而 core/pipeline.py 模块级 ``from ..agent.sysprobe import ...`` 必先执行
本 __init__，急切导入会把 AI 栈拖进每次 CLI/Web 启动（击穿 _load_agent_stack
惰性机制）。sysprobe/token_est 为独立子模块直接导入，不进 __getattr__。

实现注记：转发必须经 importlib.import_module，不能 ``from . import
runner``——后者的 fromlist 处理对未知名会再触发本 __getattr__，
形成递归（PEP 562 已知坑）。
"""

from importlib import import_module
from typing import Any

# 公开名 → 所属子模块；未登记的名字（TaskRunner/TaskEvent/AGENT_STALL_*
# 等）默认落在 runner。显式登记保证访问 build_agent 只导入 build.py，
# 不把 4.6s 的 runner（deepagents/langchain）拖进惰性路径。
_NAME_MODULE: dict[str, str] = {
    "build_agent": ".build",
    "_with_skills": ".build",
    "DenyMiddleware": ".middleware",
    "ToolErrorRetryMiddleware": ".middleware",
    "build_system_prompt": ".prompt",
    "_DIALECT_TABLE": ".prompt",
    "build_chat_model": ".model",
}


def __getattr__(name: str) -> Any:
    module = import_module(_NAME_MODULE.get(name, ".runner"), __name__)
    return getattr(module, name)
