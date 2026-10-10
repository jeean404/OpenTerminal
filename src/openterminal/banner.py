"""旧路径壳（阶段二 Task 15）：实现已迁至 frontend/banner.py。"""

from .frontend.banner import *  # noqa: F401,F403
from .frontend import banner as _impl  # noqa: F401

def __getattr__(name):
    return getattr(_impl, name)
