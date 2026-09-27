"""ot exec / ot list 无头执行面测试（headless.py）。

不建真实 SSH 连接：目标解析、Policy 门禁、退出码与 JSON 形状全部
在 resolve_target / _gate / run_headless 层面验证。
"""

import io
import json

from openterminal.config import Config, PolicyConfig, TargetConfig
from openterminal.headless import (
    EXIT_APPROVAL_REQUIRED,
    EXIT_DENIED,
    EXIT_TARGET_NOT_FOUND,
    EXIT_USAGE,
    build_parser,
    resolve_target,
    run_headless,
)


def _cfg(targets: dict | None = None, policy: PolicyConfig | None = None) -> Config:
    cfg = Config()
    if targets:
        cfg.targets = targets
    if policy:
        cfg.policy = policy
    return cfg


def _run(argv, cfg, monkeypatch=None):
    """跑一次无头入口，返回 (exit_code, stdout, stderr)。"""
    out, err = io.StringIO(), io.StringIO()
    code = run_headless(argv, cfg=cfg, out=out, err=err)
    return code, out.getvalue(), err.getvalue()


# ---------------------------------------------------------------------------
# 目标解析
# ---------------------------------------------------------------------------

def test_resolve_target_exact_and_fuzzy():
    cfg = _cfg({"web-prod-01": TargetConfig(name="web-prod-01", mode="ssh",
                                            host="10.0.0.1", user="root")})
    t, names = resolve_target("web-prod-01", cfg)
    assert t is not None and t.host == "10.0.0.1"
    assert "web-prod-01" in names

    # 拼写错误 → 模糊匹配给出候选
    t, names = resolve_target("web-pord-01", cfg)
    assert t is None
    assert names and names[0] == "web-prod-01"


def test_resolve_target_no_candidates():
    cfg = _cfg({"db-main": TargetConfig(name="db-main", mode="ssh", host="10.0.0.9")})
    t, names = resolve_target("nothing-like-it", cfg)
    assert t is None and names == []


def test_all_targets_config_alias_survives_same_host_saved(monkeypatch):
    """记住的连接与手写目标同址：手写别名（prod）不被 host 去重吞掉，
    仅同名时跳过（修复：曾按 host 键把 config 手写目标整个吃掉，
    `ot exec -t prod` 报目标不存在）。"""
    import openterminal.connections as conn_mod
    from openterminal.headless import all_targets

    monkeypatch.setattr(conn_mod, "load_saved_targets", lambda *a, **k: [
        TargetConfig(name="root@10.0.0.1", mode="ssh", host="10.0.0.1",
                     user="root")])
    cfg = _cfg({"prod": TargetConfig(name="prod", mode="ssh",
                                     host="10.0.0.1", user="root")})
    names = [t.name for t in all_targets(cfg)]
    assert "prod" in names and "root@10.0.0.1" in names


# ---------------------------------------------------------------------------
# ot exec —— 门禁与结构化错误
# ---------------------------------------------------------------------------

def test_exec_target_not_found_includes_candidates():
    cfg = _cfg({"web-prod": TargetConfig(name="web-prod", mode="ssh", host="h")})
    code, _, err = _run(["exec", "-t", "web-pord", "-c", "ls", "--output", "json"], cfg)
    assert code == EXIT_TARGET_NOT_FOUND
    payload = json.loads(err)
    assert payload["code"] == "TARGET_NOT_FOUND"
    assert payload["candidates"] == ["web-prod"]


def test_exec_missing_command_is_usage_error():
    cfg = _cfg({"a": TargetConfig(name="a", mode="ssh", host="h")})
    code, _, err = _run(["exec", "-t", "a", "-c", "", "--output", "json"], cfg)
    assert code == EXIT_USAGE
    assert json.loads(err)["code"] == "USAGE"


def test_exec_denied_by_policy():
    cfg = _cfg(
        {"a": TargetConfig(name="a", mode="ssh", host="h")},
        PolicyConfig(deny_extra=["rm -rf /data"]),
    )
    code, _, err = _run(["exec", "-t", "a", "-c", "rm -rf /data", "--output", "json"], cfg)
    assert code == EXIT_DENIED
    payload = json.loads(err)
    assert payload["code"] == "DENIED"
    assert payload["command"] == "rm -rf /data"


def test_exec_approval_required_has_hint():
    # sudo 提权类命令分级为 approve（shutdown 类是 deny，另有用例）
    cfg = _cfg({"a": TargetConfig(name="a", mode="ssh", host="h")})
    code, _, err = _run(
        ["exec", "-t", "a", "-c", "sudo systemctl restart nginx", "--output", "json"], cfg)
    assert code == EXIT_APPROVAL_REQUIRED
    payload = json.loads(err)
    assert payload["code"] == "APPROVAL_REQUIRED"
    assert "auto_extra" in payload["hint"]


def test_exec_forbidden_verb_is_deny_not_approval():
    cfg = _cfg({"a": TargetConfig(name="a", mode="ssh", host="h")})
    code, _, err = _run(
        ["exec", "-t", "a", "-c", "shutdown -h now", "--output", "json"], cfg)
    assert code == EXIT_DENIED


def test_exec_approve_all_mode_blocks_everything():
    cfg = _cfg(
        {"a": TargetConfig(name="a", mode="ssh", host="h")},
        PolicyConfig(mode="approve-all"),
    )
    code, _, _ = _run(["exec", "-t", "a", "-c", "ls", "--output", "json"], cfg)
    assert code == EXIT_APPROVAL_REQUIRED


def test_exec_local_target_end_to_end():
    # local 目标跳过指纹预检，走真实本地 PTY：门禁放行 → 执行 → 退出码透传
    from openterminal.config import TargetConfig as T
    cfg = _cfg({"localbox": T(name="localbox", mode="local")},
               PolicyConfig(auto_extra=["echo ot-exec-ok"]))
    code, out, err = _run(
        ["exec", "-t", "localbox", "-c", "echo ot-exec-ok", "--output", "json"], cfg)
    assert code == 0, err
    payload = json.loads(out)
    assert payload["exit_code"] == 0
    assert "ot-exec-ok" in payload["output"]
    assert payload["target"] == "localbox"


def test_exec_host_key_unknown_blocked_before_connect():
    cfg = _cfg({"a": TargetConfig(name="a", mode="ssh", host="no-such-host.invalid")})
    code, _, err = _run(["exec", "-t", "a", "-c", "ls", "--output", "json"], cfg)
    assert code == 69
    payload = json.loads(err)
    assert payload["code"] == "HOST_KEY_UNKNOWN"


def test_exec_remote_code_in_tool_band_squashed(monkeypatch):
    """远程退出码撞上 64~69 工具保留段：进程码收敛为 63（保住「≥64 必是
    工具问题」契约），真实值仍在 JSON 的 exit_code 里。"""
    import openterminal.headless as hl
    from openterminal.shell_session import CommandResult

    async def fake_exec(target, command, *, timeout):
        return CommandResult(output="boom", exit_code=65, truncated=False,
                             cwd="/")

    monkeypatch.setattr(hl, "_exec_async", fake_exec)
    cfg = _cfg({"box": TargetConfig(name="box", mode="local")},
               PolicyConfig(auto_extra=["false"]))
    code, out, err = _run(
        ["exec", "-t", "box", "-c", "false", "--output", "json"], cfg)
    assert code == 63, err
    assert json.loads(out)["exit_code"] == 65


# ---------------------------------------------------------------------------
# ot list targets
# ---------------------------------------------------------------------------

def test_list_targets_text_and_json():
    cfg = _cfg({"web": TargetConfig(name="web", mode="ssh", host="10.0.0.1",
                                    user="root", port=2222),
                "default": TargetConfig(name="default", mode="local")})
    code, out, _ = _run(["list", "targets"], cfg)
    assert code == 0
    assert "web\troot@10.0.0.1:2222" in out

    code, out, _ = _run(["list", "targets", "--output", "json"], cfg)
    assert code == 0
    payload = json.loads(out)
    names = {t["name"] for t in payload["targets"]}
    assert {"web", "default"} <= names
    web = next(t for t in payload["targets"] if t["name"] == "web")
    assert web["port"] == 2222 and "jump" not in web


def test_list_unknown_what_is_usage_error():
    cfg = Config()
    code, _, err = _run(["list", "bogus", "--output", "json"], cfg)
    assert code == EXIT_USAGE
    assert json.loads(err)["code"] == "USAGE"
