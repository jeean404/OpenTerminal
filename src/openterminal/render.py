"""旧路径壳（阶段二 Task 15）：实现已迁至 frontend/render.py。"""

from .frontend.render import *  # noqa: F401,F403
from .frontend import render as _impl  # noqa: F401

def __getattr__(name):
    return getattr(_impl, name)
