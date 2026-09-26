"""TOFU known_hosts 纯函数测试（无需真实 SSH 服务）。"""

from types import SimpleNamespace

from openterminal.ssh_pty import (
    format_known_host_line,
    known_hosts_has_entry,
)


class FakeKey:
    algorithm = b"ssh-ed25519"  # asyncssh 实际返回 bytes
    public_data = b"fake-blob"


def test_has_entry_plain_and_bracketed(tmp_path):
    p = tmp_path / "known_hosts"
    p.write_text(
        "prod-web ssh-ed25519 AAAANOTREAL==\n"
        "[jump]:2222 ssh-ed25519 AAAANOTREAL==\n"
        "# comment host\n"
        "@cert-authority ca-host ssh-rsa AAAA==\n",
        encoding="utf-8",
    )
    assert known_hosts_has_entry(p, "prod-web")
    assert known_hosts_has_entry(p, "jump", 2222)
    assert not known_hosts_has_entry(p, "jump")            # 仅非标准端口条目
    assert not known_hosts_has_entry(p, "ca-host")        # @ 指令行不算
    assert not known_hosts_has_entry(p, "missing")
    assert not known_hosts_has_entry(tmp_path / "nope", "x")


def test_has_entry_comma_patterns(tmp_path):
    p = tmp_path / "known_hosts"
    p.write_text("a,b,127.0.0.1 ssh-ed25519 AAAA==\n", encoding="utf-8")
    assert known_hosts_has_entry(p, "b")
    assert known_hosts_has_entry(p, "127.0.0.1")


def test_format_line_default_and_custom_port():
    line = format_known_host_line("h", None, FakeKey())
    assert line.startswith("h ssh-ed25519 ")
    line2222 = format_known_host_line("h", 2222, FakeKey())
    assert line2222.startswith("[h]:2222 ssh-ed25519 ")
    # 默认 22 端口不使用括号形式
    assert format_known_host_line("h", 22, FakeKey()).startswith("h ")
