"""旧路径壳（阶段二 Task 16）：实现已收编至 core/transcript.py。"""

from .core.transcript import *  # noqa: F401,F403
from .core import transcript as _impl  # noqa: F401

def __getattr__(name):
    return getattr(_impl, name)
