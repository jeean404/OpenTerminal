"""cmdset 纯函数单测:内联密码抽取(keyring 引用化)与 @引用解析。"""
from types import SimpleNamespace

from openterminal.cmdset import extract_inline_secrets, resolve_answer


def test_extract_stores_secret_and_rewrites(monkeypatch):
    stored = {}
    monkeypatch.setattr("openterminal.cmdset.store_password",
                        lambda key, u, p, pw: stored.__setitem__(key, pw) or True)
    text = "ssh root@db01\r\n> @db01= s3cret \n> y\n# 注释\n"
    out, failed = extract_inline_secrets(text)
    assert stored == {"cmdset:db01": "s3cret"}
    assert out == "ssh root@db01\n> @db01\n> y\n# 注释\n"   # CRLF 归一 + 密码消失
    assert failed == []


def test_extract_empty_secret_is_pure_reference(monkeypatch):
    stored = {}
    monkeypatch.setattr("openterminal.cmdset.store_password",
                        lambda key, u, p, pw: stored.__setitem__(key, pw) or True)
    out, _ = extract_inline_secrets("> @db01=\n")
    assert stored == {}                     # 空密码不写库
    assert out == "> @db01\n"


def test_extract_keyring_failure_reports(monkeypatch):
    # 凭据库不可用:行仍改写为引用(明文绝不落库),名字进 failed 列表
    monkeypatch.setattr("openterminal.cmdset.store_password",
                        lambda *a: False)
    out, failed = extract_inline_secrets("> @db01=s3cret\n")
    assert out == "> @db01\n"
    assert failed == ["db01"]


def test_resolve_prefers_cmdset_namespace(monkeypatch):
    monkeypatch.setattr(
        "openterminal.cmdset.load_password",
        lambda k, u, p: {"cmdset:db01": "a"}.get(k))
    assert resolve_answer("db01") == "a"


def test_resolve_falls_back_to_saved_host(monkeypatch):
    def fake_load(k, u, p):
        return "b" if k == "10.0.0.5" else None
    monkeypatch.setattr("openterminal.cmdset.load_password", fake_load)
    monkeypatch.setattr(
        "openterminal.cmdset.find_saved_target",
        lambda name: SimpleNamespace(name="db01", host="10.0.0.5",
                                     user="root", port=None))
    assert resolve_answer("db01") == "b"


def test_resolve_missing_returns_none(monkeypatch):
    monkeypatch.setattr("openterminal.cmdset.load_password", lambda k, u, p: None)
    monkeypatch.setattr("openterminal.cmdset.find_saved_target",
                        lambda name: None)
    assert resolve_answer("nope") is None
