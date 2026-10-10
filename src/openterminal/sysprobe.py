"""旧路径壳（阶段二 Task 14）：实现已迁至 agent/sysprobe.py。"""

from .agent.sysprobe import *  # noqa: F401,F403
from .agent import sysprobe as _impl  # noqa: F401

def __getattr__(name):
    return getattr(_impl, name)
