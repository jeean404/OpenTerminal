"""token_est：tiktoken 估算与启发式兜底。"""

import openterminal.token_est as te


def test_empty_text_is_zero():
    assert te.count_tokens("") == 0


def test_tiktoken_path_counts():
    """tiktoken 可用时按 BPE 计价（词表已缓存；不可用则本测试跳过逻辑由下条覆盖）。"""
    n = te.count_tokens("hello world, this is a token count probe")
    assert n > 0


def test_special_token_text_does_not_raise():
    # disallowed_special=()：正文里的特殊 token 形态按普通文本计价
    n = te.count_tokens(" pseudo <|endoftext|> marker")
    assert n > 0


def test_heuristic_fallback(monkeypatch):
    """编码器不可用时退化为字符启发式：CJK 加权、ASCII 约 4 字符/token。"""
    monkeypatch.setattr(te, "_encoding", lambda: None)
    ascii_n = te.count_tokens("abcdefgh")            # 8 字符 → 2
    assert ascii_n == 2
    cjk_n = te.count_tokens("帮我查看磁盘占用")        # 8 个 CJK → 8*1.6
    assert cjk_n == int(8 * 1.6)
    assert te.count_tokens("x" * 3) == 1             # max(1, …) 下限
