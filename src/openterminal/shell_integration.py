"""旧路径壳（阶段二 Task 13）：实现已迁至 shell/integration.py。"""

from .shell.integration import *  # noqa: F401,F403
from .shell import integration as _impl  # noqa: F401 —— 便于测试直引私有名

def __getattr__(name):
    return getattr(_impl, name)
