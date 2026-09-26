"""系统凭据库存取：正常往返、凭据库缺席时静默降级。"""

import pytest

from openterminal.secrets_store import load_password, store_password


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
