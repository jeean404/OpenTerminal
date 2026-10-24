"""模型配置的「连接测试」：URL + API Key 是否有效、能不能连通。

连不通是**测试结论**不是请求出错，故 check_connection 回 ``{ok, detail}``
而不抛异常；只有入参不全才是 ValueError（HTTP 400）。
"""

import pytest

from openterminal.model_profiles import check_connection


class _Ok:
    content = "pong"


class _Bad:
    def invoke(self, _prompt):
        raise RuntimeError("401 Unauthorized: invalid api key")


class _Good:
    def invoke(self, _prompt):
        return _Ok()


def _patch(monkeypatch, chat):
    monkeypatch.setattr(
        "openterminal.agent.model.build_chat_model", lambda cfg: chat)


BASE = {"provider": "openai", "base_url": "https://api.example.com/v1",
        "model": "gpt-5", "api_key": "sk-test"}


def test_missing_model_is_client_error():
    with pytest.raises(ValueError, match="协议与模型"):
        check_connection({"provider": "openai", "model": "", "api_key": "k"})


def test_anthropic_needs_base_url():
    with pytest.raises(ValueError, match="必须填写 URL"):
        check_connection({"provider": "anthropic", "model": "claude-x",
                         "api_key": "k"})


def test_no_api_key_is_client_error():
    with pytest.raises(ValueError, match="API Key"):
        check_connection({"provider": "openai", "model": "gpt-5"})


def test_connection_success(monkeypatch):
    _patch(monkeypatch, _Good())
    result = check_connection(dict(BASE))
    assert result["ok"] is True and "pong" in result["detail"]


def test_connection_failure_is_reported_not_raised(monkeypatch):
    _patch(monkeypatch, _Bad())
    result = check_connection(dict(BASE))
    assert result["ok"] is False
    assert "401" in result["detail"], "失败原因要原样带给用户看"


def test_saved_key_is_used_when_input_blank(monkeypatch):
    """编辑时留空 API Key 也能测：用已保存的那把，别逼用户把它复制出来。"""
    seen = {}

    class _Recorder:
        def invoke(self, _prompt):
            return _Ok()

    def _factory(cfg):
        seen["cfg"] = cfg
        return _Recorder()

    monkeypatch.setattr("openterminal.agent.model.build_chat_model", _factory)
    monkeypatch.setattr(
        "openterminal.model_profiles.load_model_api_key",
        lambda pid: "sk-saved" if pid == "p1" else None)
    result = check_connection({"provider": "openai", "model": "gpt-5",
                              "profile_id": "p1"})
    assert result["ok"] is True
    assert seen["cfg"].api_key == "sk-saved"
