"""协议 provider 分支：build_chat_model 按 provider 构造对应 langchain 模型。"""
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI

from openterminal.agent import build_chat_model
from openterminal.config import ModelConfig


def test_default_provider_builds_anthropic():
    m = build_chat_model(ModelConfig())
    assert isinstance(m, ChatAnthropic)
    assert m.model == "claude-sonnet-4-6"


def test_openai_provider_builds_openai():
    cfg = ModelConfig(provider="openai", model="gpt-5", base_url="",
                      api_key_env="OPENAI_API_KEY")
    m = build_chat_model(cfg)
    assert isinstance(m, ChatOpenAI)
    assert m.model_name == "gpt-5"
    # base_url 留空 → SDK 官方端点（openai_api_base 不落地）
    assert m.openai_api_base is None


def test_openai_provider_custom_base_url():
    cfg = ModelConfig(provider="openai", model="deepseek-chat",
                      base_url="https://gw.example/v1", api_key_env="MY_KEY")
    m = build_chat_model(cfg)
    assert isinstance(m, ChatOpenAI)
    assert m.openai_api_base == "https://gw.example/v1"
