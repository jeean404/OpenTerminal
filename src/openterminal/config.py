"""配置加载：~/.openterminal/config.toml + 默认值。"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


def app_dir() -> Path:
    return Path(
        os.environ.get("OPENTERMINAL_HOME", str(Path.home() / ".openterminal"))
    )


_DEFAULT_MODELS = [
    "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5",
]

# provider = "openai"（OpenAI 兼容协议）时的缺省值：模型、下拉可选列表与
# anthropic 各一套；config.toml 显式写了的字段一律优先
_DEFAULT_MODEL_OPENAI = "gpt-5"
_DEFAULT_MODELS_OPENAI = [
    "gpt-5", "gpt-5-mini", "o4-mini",
]


@dataclass
class ModelConfig:
    provider: str = "anthropic"  # anthropic | openai（OpenAI 兼容协议）
    base_url: str = "http://127.0.0.1:15721"
    model: str = "claude-sonnet-4-6"
    api_key_env: str = "ANTHROPIC_API_KEY"
    # Web 状态栏模型下拉的可选模型（可在 config.toml [model] models 覆盖）
    models: list[str] = field(default_factory=lambda: list(_DEFAULT_MODELS))


@dataclass
class ShellConfig:
    timeout_default: int = 120
    max_output_bytes: int = 102_400
    max_tool_turns: int = 10


@dataclass
class PolicyConfig:
    mode: str = "tiered"  # tiered | approve-all | deny-all
    auto_extra: list[str] = field(default_factory=list)
    approve_extra: list[str] = field(default_factory=list)
    deny_extra: list[str] = field(default_factory=list)


@dataclass
class WebConfig:
    host: str = "127.0.0.1"
    port: int = 8080
    token: str = ""


@dataclass
class TargetConfig:
    name: str = "default"
    mode: str = "local"  # local | ssh
    host: str | None = None
    user: str | None = None
    port: int | None = None
    commands: list[str] = field(default_factory=list)  # 连接后自动执行的命令集(原样行,空行/# 注释由 runner 跳过)


@dataclass
class Config:
    model: ModelConfig = field(default_factory=ModelConfig)
    shell: ShellConfig = field(default_factory=ShellConfig)
    policy: PolicyConfig = field(default_factory=PolicyConfig)
    web: WebConfig = field(default_factory=WebConfig)
    targets: dict[str, TargetConfig] = field(
        default_factory=lambda: {"default": TargetConfig()}
    )

    @classmethod
    def load(cls, path: Path | None = None) -> "Config":
        path = path or (app_dir() / "config.toml")
        data: dict = {}
        if path.exists():
            data = tomllib.loads(path.read_text(encoding="utf-8"))

        m, s, p = data.get("model", {}), data.get("shell", {}), data.get("policy", {})
        w = data.get("web", {})
        # 协议 provider：anthropic（缺省）| openai（OpenAI 兼容协议）。脏值容错：
        # 未知值回落 anthropic，与 port 写坏只丢字段同一哲学——配置手误不
        # 打挂启动。provider 决定 base_url / model / api_key_env / models 的
        # 缺省套（openai 不再继承 anthropic 网关地址），显式字段一律优先。
        provider = str(m.get("provider", "anthropic")).strip().lower()
        if provider not in ("anthropic", "openai"):
            provider = "anthropic"
        openai = provider == "openai"
        targets: dict[str, TargetConfig] = {
            "default": TargetConfig(
                mode=data.get("target", {}).get("default", {}).get("mode", "local")
            )
        }
        for name, t in data.get("target", {}).items():
            if name == "default":
                continue
            # 脏值容错：port 写坏（如 "22abc"）只丢该字段，commands 允许
            # TOML 数组或字符串——单个目标的手误不打挂整个启动
            try:
                port = int(t["port"]) if t.get("port") is not None else None
            except (TypeError, ValueError):
                port = None
            raw_cmds = t.get("commands")
            if isinstance(raw_cmds, list):
                commands = [str(c) for c in raw_cmds]
            elif raw_cmds:
                commands = str(raw_cmds).splitlines()
            else:
                commands = []
            targets[name] = TargetConfig(
                name=name,
                mode=t.get("mode", "ssh"),
                host=t.get("host"),
                user=t.get("user"),
                port=port,
                commands=commands,
            )
        return cls(
            model=ModelConfig(
                provider=provider,
                base_url=m.get("base_url", "" if openai else ModelConfig.base_url),
                model=m.get("model",
                            _DEFAULT_MODEL_OPENAI if openai else ModelConfig.model),
                api_key_env=m.get(
                    "api_key_env",
                    "OPENAI_API_KEY" if openai else ModelConfig.api_key_env),
                models=list(m.get(
                    "models",
                    _DEFAULT_MODELS_OPENAI if openai else _DEFAULT_MODELS)),
            ),
            shell=ShellConfig(
                timeout_default=int(s.get("timeout_default", 120)),
                max_output_bytes=int(s.get("max_output_bytes", 102_400)),
                max_tool_turns=int(s.get("max_tool_turns", 10)),
            ),
            policy=PolicyConfig(
                mode=p.get("mode", "tiered"),
                auto_extra=list(p.get("auto_extra", [])),
                approve_extra=list(p.get("approve_extra", [])),
                deny_extra=list(p.get("deny_extra", [])),
            ),
            web=WebConfig(
                host=w.get("host", WebConfig.host),
                port=int(w.get("port", WebConfig.port)),
                token=w.get("token", WebConfig.token),
            ),
            targets=targets,
        )
