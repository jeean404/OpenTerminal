"""旧路径壳（阶段二 Task 15）：实现已迁至 frontend/taskview.py。"""

from .frontend.taskview import *  # noqa: F401,F403
from .frontend import taskview as _impl  # noqa: F401

def __getattr__(name):
    return getattr(_impl, name)
