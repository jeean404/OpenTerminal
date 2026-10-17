from pathlib import Path

from openterminal.config import Config, app_dir


def test_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    # 隔离 CWD 的 .env（本组用例测 config.toml 语义；.env 协议探测另测）
    monkeypatch.setattr("openterminal.config.load_env", lambda: {})
    cfg = Config.load()
    assert cfg.model.base_url == "http://127.0.0.1:15721"
    assert cfg.model.model == "claude-sonnet-4-6"
    assert cfg.shell.timeout_default == 120
    assert cfg.shell.max_output_bytes == 102_400
    assert cfg.shell.max_tool_turns == 10
    assert cfg.policy.mode == "tiered"
    assert cfg.targets["default"].mode == "local"
    assert app_dir() == tmp_path


def test_toml_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    # 隔离 CWD 的 .env（本组用例测 config.toml 语义；.env 协议探测另测）
    monkeypatch.setattr("openterminal.config.load_env", lambda: {})
    (tmp_path / "config.toml").write_text(
        '[model]\nmodel = "glm-5"\n'
        '[shell]\ntimeout_default = 30\n'
        '[policy]\n'
        'deny_extra = ["git push"]\n'
        '[target.prod]\nmode = "ssh"\nhost = "prod-web"\n',
        encoding="utf-8",
    )
    cfg = Config.load()
    assert cfg.model.model == "glm-5"
    assert cfg.shell.timeout_default == 30
    assert cfg.policy.deny_extra == ["git push"]
    assert cfg.targets["prod"].mode == "ssh"
    assert cfg.targets["prod"].host == "prod-web"


def test_web_config_section(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    # 隔离 CWD 的 .env（本组用例测 config.toml 语义；.env 协议探测另测）
    monkeypatch.setattr("openterminal.config.load_env", lambda: {})
    (tmp_path / "config.toml").write_text(
        '[web]\nhost = "0.0.0.0"\nport = 8899\ntoken = "abc"\n', encoding="utf-8")
    cfg = Config.load()
    assert cfg.web.host == "0.0.0.0"
    assert cfg.web.port == 8899
    assert cfg.web.token == "abc"


def test_web_config_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    # 隔离 CWD 的 .env（本组用例测 config.toml 语义；.env 协议探测另测）
    monkeypatch.setattr("openterminal.config.load_env", lambda: {})
    cfg = Config.load()
    assert cfg.web.host == "127.0.0.1"
    assert cfg.web.port == 8080
    assert cfg.web.token == ""


def test_openai_provider_defaults(tmp_path, monkeypatch):
    """provider=openai 时缺省值换一套：不继承 anthropic 网关/模型/密钥环境变量。"""
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    # 隔离 CWD 的 .env（本组用例测 config.toml 语义；.env 协议探测另测）
    monkeypatch.setattr("openterminal.config.load_env", lambda: {})
    (tmp_path / "config.toml").write_text(
        '[model]\nprovider = "openai"\n', encoding="utf-8")
    m = Config.load().model
    assert m.provider == "openai"
    assert m.base_url == ""
    assert m.model == "gpt-5"
    assert m.api_key_env == "OPENAI_API_KEY"
    assert m.models == ["gpt-5", "gpt-5-mini", "o4-mini"]


def test_openai_provider_explicit_fields_win(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    # 隔离 CWD 的 .env（本组用例测 config.toml 语义；.env 协议探测另测）
    monkeypatch.setattr("openterminal.config.load_env", lambda: {})
    (tmp_path / "config.toml").write_text(
        '[model]\nprovider = "openai"\n'
        'base_url = "https://gw.example/v1"\n'
        'model = "deepseek-chat"\n'
        'api_key_env = "DEEPSEEK_KEY"\n'
        'models = ["deepseek-chat"]\n',
        encoding="utf-8",
    )
    m = Config.load().model
    assert m.provider == "openai"
    assert m.base_url == "https://gw.example/v1"
    assert m.model == "deepseek-chat"
    assert m.api_key_env == "DEEPSEEK_KEY"
    assert m.models == ["deepseek-chat"]


def test_unknown_provider_falls_back_to_anthropic(tmp_path, monkeypatch):
    """脏值容错：provider 写坏回落 anthropic，不打挂启动。"""
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    # 隔离 CWD 的 .env（本组用例测 config.toml 语义；.env 协议探测另测）
    monkeypatch.setattr("openterminal.config.load_env", lambda: {})
    (tmp_path / "config.toml").write_text(
        '[model]\nprovider = "gemini"\n', encoding="utf-8")
    m = Config.load().model
    assert m.provider == "anthropic"
    assert m.base_url == "http://127.0.0.1:15721"
    assert m.api_key_env == "ANTHROPIC_API_KEY"


# --- .env 协议探测（项目 .env > ~/.openterminal/.env）---

def test_env_anthropic_pair_selects_anthropic():
    from openterminal.config import model_from_env
    over, errs = model_from_env({
        "ANTHROPIC_BASE_URL": "https://gw/anthropic",
        "ANTHROPIC_API_KEY": "sk-x",
        "MODEL_ID": "mimo-1",
    })
    assert over["provider"] == "anthropic"
    assert over["base_url"] == "https://gw/anthropic"
    assert over["api_key"] == "sk-x"
    assert over["model"] == "mimo-1"
    assert errs == []


def test_env_openai_pair_selects_openai():
    from openterminal.config import model_from_env
    over, errs = model_from_env({
        "OPENAI_BASE_URL": "https://gw/v1",
        "OPENAI_API_KEY": "sk-y",
    })
    assert over["provider"] == "openai"
    assert over["base_url"] == "https://gw/v1"
    assert errs == []


def test_env_both_protocols_is_error():
    """都配=报错（只能配一个）——红色警告卡素材。"""
    from openterminal.config import model_from_env
    over, errs = model_from_env({
        "ANTHROPIC_BASE_URL": "u", "ANTHROPIC_API_KEY": "k",
        "OPENAI_BASE_URL": "u", "OPENAI_API_KEY": "k",
    })
    assert over == {}
    assert len(errs) == 1 and "只能配一个" in errs[0]


def test_env_neither_protocol_is_error():
    """都没配=报错（红色警告卡素材）。"""
    from openterminal.config import model_from_env
    over, errs = model_from_env({})
    assert over == {}
    assert len(errs) == 1 and "未配置模型协议" in errs[0]


def test_env_incomplete_pair_is_error():
    """半套（只 base_url 没 key）不算配了——按没配报错。"""
    from openterminal.config import model_from_env
    over, errs = model_from_env({"ANTHROPIC_BASE_URL": "u"})
    assert over == {}
    assert len(errs) == 1


def test_env_priority_project_over_home(tmp_path, monkeypatch):
    """项目 .env 优先级最高（用户约定）：同名键项目覆盖家目录。"""
    from openterminal.config import load_env
    home = tmp_path / "home"
    home.mkdir()
    (home / ".env").write_text("ANTHROPIC_BASE_URL=home-url\nMODEL_ID=home-model\n",
                               encoding="utf-8")
    monkeypatch.setenv("OPENTERMINAL_HOME", str(home))
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / ".env").write_text("ANTHROPIC_BASE_URL=proj-url\n", encoding="utf-8")
    monkeypatch.chdir(proj)
    env = load_env()
    assert env["ANTHROPIC_BASE_URL"] == "proj-url"   # 项目覆盖家目录
    assert env["MODEL_ID"] == "home-model"           # 家目录兜底
