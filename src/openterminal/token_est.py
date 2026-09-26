"""tiktoken 本地 token 估算：状态栏「本次会话消耗」的兜底口径。

真实 usage_metadata 只在模型网关回传时可得；本地代理/第三方聚合网关经常
不回传，此时按 tiktoken 对「我们能看到的双向文本」（任务文本+工具输出 ↔
思考+正文）估算。BPE 词表首次使用需联网下载，之后走 TIKTOKEN_CACHE_DIR
本地缓存（落在应用数据目录，离线可用）；tiktoken 未安装或词表不可得时
退化为字符启发式——估算绝不能打死主流程。
"""
import os

from .config import app_dir

os.environ.setdefault("TIKTOKEN_CACHE_DIR", str(app_dir() / "tiktoken_cache"))

_enc = None
_enc_failed = False


def _encoding():
    """懒加载 cl100k_base 编码器；不可用返回 None（进程内只试一次）。"""
    global _enc, _enc_failed
    if _enc is not None:
        return _enc
    if _enc_failed:
        return None
    try:
        import tiktoken
        _enc = tiktoken.get_encoding("cl100k_base")
    except Exception:            # noqa: BLE001 - 未安装/离线无词表：退化启发式
        _enc_failed = True
        _enc = None
    return _enc


def count_tokens(text: str) -> int:
    """文本 → token 数（估算口径）。"""
    if not text:
        return 0
    enc = _encoding()
    if enc is not None:
        try:
            # disallowed_special=()：正文里的 "<|...|>" 形态按普通文本计价，
            # 不当特殊 token 抛错
            return len(enc.encode(text, disallowed_special=()))
        except Exception:        # noqa: BLE001 - 编码失败走启发式
            pass
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
    other = len(text) - cjk
    return max(1, int(cjk * 1.6) + (other + 3) // 4)
