"""系统凭据库存取：正常往返、凭据库缺席时静默降级、端口别名互查。"""

import pytest

from openterminal.secrets_store import (
    load_password, load_password_alias, store_password,
)


@pytest.fixture
def fake_keyring(monkeypatch):
    """内存版 keyring：以 (service, username) 为键的字典。"""
    store: dict[tuple[str, str], str] = {}

    def set_password(service, username, password):
        store[(service, username)] = password

    def get_password(service, username):
        return store.get((service, username))

    import keyring

    monkeypatch.setattr(keyring, "set_password", set_password)
    monkeypatch.setattr(keyring, "get_password", get_password)
    return store


def test_roundtrip(fake_keyring):
    assert store_password("box", "root", 2222, "s3cret") is True
    assert load_password("box", "root", 2222) == "s3cret"
    # 键含 user 和 port，不同连接互不串
    assert load_password("box", "root", None) is None
    assert load_password("box", None, 2222) is None


def test_load_missing_entry_returns_none(fake_keyring):
    assert load_password("box", "root", None) is None


def test_keyring_unavailable_degrades(monkeypatch):
    import keyring

    def boom(*a, **k):
        raise RuntimeError("no secret service")

    monkeypatch.setattr(keyring, "set_password", boom)
    monkeypatch.setattr(keyring, "get_password", boom)
    # 写失败返回 False、读失败返回 None：连接流程回退到现场询问
    assert store_password("box", None, None, "x") is False
    assert load_password("box", None, None) is None


# --- 端口别名互查（None ↔ 22 同一凭据；P0-1 首跳/嵌套共用规范）---


def test_load_password_alias_both_directions(fake_keyring):
    # 键落在 :22 一侧：port=None 来查也要命中（嵌套 ssh 无 -p 的场景）
    store_password("box", "root", 22, "s3cret")
    assert load_password_alias("box", "root", None) == "s3cret"
    assert load_password_alias("box", "root", 22) == "s3cret"
    # 键落在无端口一侧：port=22 来查同样命中（首跳 target.port=22 的场景）
    store_password("box2", "root", None, "other")
    assert load_password_alias("box2", "root", 22) == "other"
    assert load_password_alias("box2", "root", None) == "other"


def test_load_password_alias_prefers_exact_key(fake_keyring):
    # 两侧都有条目：本键优先，别名键只兜底
    store_password("box", "root", 22, "at-22")
    store_password("box", "root", None, "at-none")
    assert load_password_alias("box", "root", 22) == "at-22"
    assert load_password_alias("box", "root", None) == "at-none"


def test_load_password_alias_non_default_port_no_cross(fake_keyring):
    # 非默认端口不互查：2222 与 None/22 是不同凭据
    store_password("box", "root", 2222, "x")
    assert load_password_alias("box", "root", None) is None
    assert load_password_alias("box", "root", 22) is None
    assert load_password_alias("box", "root", 2222) == "x"
