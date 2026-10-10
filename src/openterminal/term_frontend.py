"""旧路径壳（阶段二 Task 15）：实现已迁至 frontend/term.py。"""

from .frontend.term import *  # noqa: F401,F403
from .frontend import term as _impl  # noqa: F401

def __getattr__(name):
    return getattr(_impl, name)
