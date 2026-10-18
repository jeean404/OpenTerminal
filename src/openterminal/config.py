"""配置加载：.env（项目 > ~/.openterminal/.env）+ config.toml + 默认值。

模型协议由 .env 的 ANTHROPIC_* / OPENAI_* 二选一决定（都配=报错，都没配=报错）；
config.toml 只管 shell/policy/web/targets 与模型名（credentials 以 .env 为准）。
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


def app_dir() -> Path:
    return Path(
        os.environ.get("OPENTERMINAL_HOME", str(Path.home() / ".openterminal"))
    )


def _parse_env_file(path: Path) -> dict[str, str]:
    """极简 .env 解析：KEY=VALUE 行、# 注释、可选引号。脏行跳过不打挂。"""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if key:
            out[key] = val
    return out


def load_env() -> dict[str, str]:
    """合并 .env：项目 .env（cwd）优先 > ~/.openterminal/.env > 系统环境变量。

    「当前项目 .env 优先级最高」（用户约定）：同名键项目覆盖家目录、家目录
    覆盖系统环境。只读不动 os.environ——副作用留给调用方决定。
    """
    # 三层都要看：系统环境变量 < ~/.openterminal/.env < 项目 .env。
    # 旧实现只读两份 .env 文件、漏了系统环境变量——用户把密钥 export 在
    # shell 里时，模型明明跑得好好的却报「未配置模型协议」（真机红警告误报）
    merged: dict[str, str] = {k: v for k, v in os.environ.items() if v}
    home_env = app_dir() / ".env"
    for k, v in _parse_env_file(home_env).items():
        merged[k] = v
    project_env = Path.cwd() / ".env"
    for k, v in _parse_env_file(project_env).items():
        merged[k] = v
    return merged


def model_from_env(env: dict[str, str]) -> tuple[dict, list[str]]:
    """按 ANTHROPIC_*/OPENAI_* 二选一定协议。返回 (model 字段覆盖, 错误列表)。

    - 两套都配 → 报错（只能配一个）；都不配 → 报错（红色警告卡素材）；
    - 配了哪套走哪套协议：base_url + api_key 成对才算「配了」。
    """
    ant = ("ANTHROPIC_BASE_URL" in env and "ANTHROPIC_API_KEY" in env)
    oai = ("OPENAI_BASE_URL" in env and "OPENAI_API_KEY" in env)
    if ant and oai:
        return {}, ["模型协议冲突：ANTHROPIC_* 与 OPENAI_* 同时配置，只能配一个"]
    if ant:
        return {"provider": "anthropic",
                "base_url": env["ANTHROPIC_BASE_URL"],
                "api_key": env["ANTHROPIC_API_KEY"],
                "model": env.get("ANTHROPIC_MODEL") or env.get("MODEL_ID", "")}, []
    if oai:
        return {"provider": "openai",
                "base_url": env["OPENAI_BASE_URL"],
                "api_key": env["OPENAI_API_KEY"],
                "model": env.get("OPENAI_MODEL") or env.get("MODEL_ID", "")}, []
    return {}, ["未配置模型协议：请在项目 .env 或 ~/.openterminal/.env 配置 "
                "ANTHROPIC_BASE_URL+ANTHROPIC_API_KEY 或 "
                "OPENAI_BASE_URL+OPENAI_API_KEY"]


_DEFAULT_MODELS = [
    "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5",
]

# provider = "openai"（OpenAI 兼容协议）时的缺省值：模型、下拉可选列表与
# anthropic 各一套；config.toml 显式写了的字段一律优先
_DEFAULT_MODEL_OPENAI = "gpt-5"
_DEFAULT_MODELS_OPENAI = [
    "gpt-5", "gpt-5-mini", "o4-mini",
]


def _prune_model_errors(errors, env_model, m, environ):
    r"""去掉「未配置模型协议」的**误报**：模型真能用时不该挂红警告卡。

    判据是「跑不跑得起来」，不是「.env 里有没有那两行」。真机上就踩到过：
    config.toml [model] 给了 base_url、`api_key_env` 指向的环境变量也有值
    （shell export / 网关免密），模型一路跑得好好的，卡头却挂着红色
    「未配置模型协议」。二选一协议的**冲突**报错不在此列，照常报。
    """
    if env_model:
        return list(errors)          # .env 配了协议：原样
    key_env = str(m.get("api_key_env") or "ANTHROPIC_API_KEY")
    # 「能跑」两条路占一条即可：① 密钥在环境变量里；② config.toml 显式写了
    # base_url（本地网关可能根本不要密钥，模型照样跑得好好的）
    usable = bool(environ.get(key_env)) or bool(m.get("base_url"))
    if not usable:
        return list(errors)
    out = []
    for e in errors:
        if "未配置模型协议" in e:
            continue
        out.append(e)
    return out


@dataclass
class ModelConfig:
    provider: str = "anthropic"  # anthropic | openai（OpenAI 兼容协议）
    base_url: str = "http://127.0.0.1:15721"
    model: str = "claude-sonnet-4-6"
    api_key_env: str = "ANTHROPIC_API_KEY"
    # .env 直配的密钥（优先于 api_key_env 间接寻址）；None=走环境变量
    api_key: str | None = None
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
    # 启动期配置错误（协议二选一冲突/都缺）：Web 端出红色警告卡展示
    errors: list[str] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path | None = None) -> "Config":
        path = path or (app_dir() / "config.toml")
        data: dict = {}
        if path.exists():
            data = tomllib.loads(path.read_text(encoding="utf-8"))

        m, s, p = data.get("model", {}), data.get("shell", {}), data.get("policy", {})
        w = data.get("web", {})
        # 模型协议以 .env 为准（项目 .env > ~/.openterminal/.env > 系统环境）；
        # config.toml [model] 只兜底模型名/下拉列表，credentials 不再从它取
        env = load_env()
        env_model, env_errors = model_from_env(env)
        for k, v in env.items():
            if k.endswith("_API_KEY") and v:
                os.environ.setdefault(k, v)   # api_key_env 间接寻址要用
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
                provider=env_model.get("provider", provider),
                base_url=env_model.get("base_url") or m.get(
                    "base_url", "" if openai else ModelConfig.base_url),
                model=env_model.get("model") or m.get(
                    "model", _DEFAULT_MODEL_OPENAI if openai else ModelConfig.model),
                api_key_env=m.get(
                    "api_key_env",
                    ("OPENAI_API_KEY" if env_model.get("provider") == "openai"
                     or openai else ModelConfig.api_key_env)),
                models=list(m.get(
                    "models",
                    _DEFAULT_MODELS_OPENAI if openai else _DEFAULT_MODELS)),
                api_key=env_model.get("api_key"),
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
            errors=_prune_model_errors(env_errors, env_model, m, os.environ),
        )
