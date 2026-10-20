"""聊天模型构造（从 runner.py 拆出）。

build_chat_model 独依赖 ModelConfig；anthropic 分支的 ChatAnthropic 在
模块级导入（同原 runner.py），openai 分支在分支内惰性导入。model 只在
真正构建 agent 时被 import（build.py 或测试直引），不落在 core 启动热路径。
"""

from __future__ import annotations

import os
from typing import Any

from langchain_anthropic import ChatAnthropic

from ..config import ModelConfig


def build_chat_model(cfg: ModelConfig) -> Any:
    """按 cfg.provider 构造 langchain 聊天模型。

    anthropic → ChatAnthropic（缺省，走 base_url 网关）；openai → ChatOpenAI，
    任何 OpenAI 兼容协议网关（base_url 留空则用 SDK 官方端点）。langchain_openai
    在分支内惰性导入：anthropic 配置既不付导入耗时也不要求安装该包。
    """
    # .env 直配的 key 优先（项目 .env > ~/.openterminal/.env）；否则走环境变量
    api_key = cfg.api_key or (
        os.environ.get(cfg.api_key_env, "not-set") if cfg.api_key_env else "not-set"
    )
    if cfg.provider == "openai":
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=cfg.model,
            base_url=cfg.base_url or None,
            api_key=api_key,
            max_tokens=4096,
        )
    return ChatAnthropic(
        model=cfg.model,
        base_url=cfg.base_url,
        api_key=api_key,
        max_tokens=4096,
    )