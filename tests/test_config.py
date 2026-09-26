from pathlib import Path

from openterminal.config import Config, app_dir


def test_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
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
    (tmp_path / "config.toml").write_text(
        '[web]\nhost = "0.0.0.0"\nport = 8899\ntoken = "abc"\n', encoding="utf-8")
    cfg = Config.load()
    assert cfg.web.host == "0.0.0.0"
    assert cfg.web.port == 8899
    assert cfg.web.token == "abc"


def test_web_config_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    cfg = Config.load()
    assert cfg.web.host == "127.0.0.1"
    assert cfg.web.port == 8080
    assert cfg.web.token == ""
