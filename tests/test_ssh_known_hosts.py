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


# --- 哈希条目（HashKnownHosts=yes，|1|盐|HMAC-SHA1 摘要）---


def _hash_token(name: str, salt: bytes = b"0123456789ab") -> str:
    import base64
    import hashlib
    import hmac

    digest = hmac.new(salt, name.encode("utf-8"), hashlib.sha1).digest()
    return "|1|%s|%s" % (base64.b64encode(salt).decode(),
                         base64.b64encode(digest).decode())


def test_has_entry_hashed_hostnames(tmp_path):
    """修复：哈希条目曾一律视为「无条目」——TOFU 的「已收录但密钥不符 →
    硬失败」防线被绕过（对哈希库主机误走 TOFU 询问），无头预检假阴性 exit 69。"""
    p = tmp_path / "known_hosts"
    p.write_text(f"{_hash_token('prod-web')} ssh-ed25519 AAAA==\n"
                 f"{_hash_token('[jump]:2222')} ssh-ed25519 AAAA==\n",
                 encoding="utf-8")
    assert known_hosts_has_entry(p, "prod-web")
    assert known_hosts_has_entry(p, "jump", 2222)
    assert not known_hosts_has_entry(p, "jump")        # 仅非标准端口条目
    assert not known_hosts_has_entry(p, "missing")


def test_has_entry_hashed_malformed_not_crash(tmp_path):
    """畸形哈希条目（版本号不符/base64 非法/段数不对）：判 False，不抛。"""
    p = tmp_path / "known_hosts"
    p.write_text("|1|not!base64|AAAA ssh-rsa A\n"
                 "|2|c2FsdA|AAAA ssh-rsa A\n"
                 "|1|onlythree ssh-rsa A\n"
                 "| ssh-rsa A\n",
                 encoding="utf-8")
    assert not known_hosts_has_entry(p, "x")
