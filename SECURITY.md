# Security Policy

## Scope

OpenTerminal is a terminal agent that executes real commands on real
machines — local shells and remote hosts over SSH. Its security-sensitive
surfaces include:

- command tiering (auto / approve / deny) in `src/openterminal/policy.py`
- the human-in-the-loop approval flow (`approval.py`, `agent.py`)
- credential storage (`secrets_store.py`) and SSH host-key handling (TOFU,
  `ssh_pty.py`)
- the web terminal's bind/token model (`src/openterminal/web/`)

## Supported versions

Only the latest commit on the default branch is supported. OpenTerminal is
in beta; please run it against production systems with care.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub
issues.

Instead, open a
[private security advisory](https://github.com/JaquariusJ/OpenTerminal/security/advisories/new)
on GitHub, or contact the maintainer directly. Include:

- a description of the issue and its impact;
- reproduction steps or a proof of concept;
- the affected code path (file / module) if known.

You can expect an initial response within a few days. Please keep the report
private until a fix is released.

## Deployment hardening notes

- `ot web` **requires** `--token` (or `[web] token` in config.toml) when
  binding to a non-loopback address — do not bypass this; the token gates
  full shell and agent access to your machines.
- Everything the agent runs is visible in the approval panel before
  execution; the tiered policy is a safety net, not a sandbox. Do not rely
  on it as a security boundary against a hostile model or a compromised
  gateway.
- Connection passwords are stored in the OS credential store (keyring), never
  in plaintext config files; transcripts under `~/.openterminal/sessions/`
  may contain command output — consider that when pointing the tool at
  sensitive systems.
