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


@dataclass
class ModelConfig:
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
        targets: dict[str, TargetConfig] = {
            "default": TargetConfig(
                mode=data.get("target", {}).get("default", {}).get("mode", "local")
            )
        }
        for name, t in data.get("target", {}).items():
            if name == "default":
                continue
            targets[name] = TargetConfig(
                name=name,
                mode=t.get("mode", "ssh"),
                host=t.get("host"),
                user=t.get("user"),
                port=int(t["port"]) if t.get("port") else None,
                commands=str(t["commands"]).splitlines() if t.get("commands") else [],
            )
        return cls(
            model=ModelConfig(
                base_url=m.get("base_url", ModelConfig.base_url),
                model=m.get("model", ModelConfig.model),
                api_key_env=m.get("api_key_env", ModelConfig.api_key_env),
                models=list(m.get("models", _DEFAULT_MODELS)),
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
