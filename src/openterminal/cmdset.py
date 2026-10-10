"""旧路径壳（阶段二 Task 13）：实现已迁至 shell/cmdset.py。"""

from .shell.cmdset import *  # noqa: F401,F403
from .shell import cmdset as _impl  # noqa: F401 —— 便于测试直引私有名

def __getattr__(name):
    return getattr(_impl, name)
