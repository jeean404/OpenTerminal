# OpenTerminal

[![CI](https://github.com/jeean404/OpenTerminal/actions/workflows/ci.yml/badge.svg)](https://github.com/jeean404/OpenTerminal/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[中文文档](README.zh-CN.md)

**Tell your terminal what you want in plain language — it does the work.**

OpenTerminal lives in your terminal (and your browser). Type a normal sentence
like *"check which files are eating the most space"* and it figures out the
right commands, runs them, and sums up the results. Plain commands still work
exactly as you'd expect. It can hop to your remote servers over SSH too, so
you can leave Xshell behind.

<div align="center">
  <img src="docs/images/demo-terminal.gif" width="860" alt="OpenTerminal terminal demo: plain command → natural language task → streaming analysis → approval → execution → summary"><br><br>
  <img src="docs/images/demo-web.gif" width="860" alt="OpenTerminal demo: natural language task → analysis → approval → execution → summary">
</div>

Both GIFs show the same flow — the first in the plain terminal (`ot`), the
second in the browser (`ot web`). Here's what happens:

1. A plain command first — `ls /tmp/ot-demo` runs in your real shell,
   colored output and all;
2. then a plain-language task: *"看看 /tmp/ot-demo 下哪些目录最占空间，
   给我一张表"*;
3. the AI streams its **thinking** and **analysis** — what it's about to
   do and why;
4. an **approval panel** pops up with the exact command — nothing runs
   without your OK;
5. you hit **执行 (Execute)** — the command runs in the same terminal,
   output shown verbatim;
6. a **summary** card wraps up, its markdown table built from the real
   output.

> ⚠️ **Beta**: OpenTerminal runs real commands on real machines — including
> production servers. Every state-changing command needs your approval (see
> [Security model](#security-model)), but please still read what you're approving.
> Security-sensitive disclosures: [SECURITY.md](SECURITY.md).

## Why you might like it

- **Say it, don't grep it.** Natural language in, correct commands out — with
  the analysis shown before anything runs.
- **It knows your systems.** Ubuntu→apt, CentOS 7→yum, Rocky/Fedora→dnf,
  Alpine→apk, macOS→brew. Same request, right dialect for each machine.
- **It doesn't get sloppy.** Read-only commands run by themselves; anything
  destructive waits for your approval; catastrophic commands (`rm -rf /`,
  fork bombs, …) are refused outright. Failed attempts get a bounded
  self-correction budget (10 turns), not infinite retry loops.
- **Your shell stays yours.** Persistent session (`cd`, exports, venv all
  survive), and full-screen programs like vim/top/tmux take over the
  terminal natively — the pipeline is a true PTY passthrough, so
  they just work inline.
- **Two ways in.** A single-pipeline terminal (`ot`), or `ot web` — a
  browser UI with a server sidebar and multi-tab terminals, sharing the
  same core.

## Features

**Natural-language tasks**

- Streaming **thinking → analysis → approval → execution → summary** for
  every task; summaries are markdown built from the real command output
- Plain commands and plain sentences share one input line — `!` forces a
  command, `?` forces a task; Ctrl+C interrupts a running task
- Slash commands: `/help` list them · `/target` switch host · `/system`
  override dialect · `/clear` new task · `/model` show model · `/exit` quit
- Bounded self-correction: a failed command is retried at most once,
  tool-call turns are budget-capped
- Session token usage on the status line — exact when the gateway reports
  it, a local tiktoken estimate otherwise

**Shells & systems**

- Persistent sessions — `cd`, exports, and venvs survive across tasks
- Full-screen programs (vim / top / tmux) run inline via true PTY
  passthrough
- Dialects auto-detected: Ubuntu/Debian→apt, CentOS 7→yum, Rocky/Fedora→dnf,
  Alpine→apk, Arch→pacman, macOS→brew — with `/system` manual override
- Local shells on macOS & Linux (PTY) and Windows (ConPTY + PowerShell)

**Agent skills**

- Skill packs ship inside the package (e.g. `markdown-tables`); their
  `SKILL.md` files are mounted at `/skills/` and the model pulls one in
  only when the task calls for it

**SSH & connections**

- Hosts from `~/.ssh/config`, ad-hoc `user@host:port`, or remembered
  connections
- Password and key auth; passwords live in the OS keyring, never in
  plaintext files
- Host-key TOFU confirmation; per-target history is replayed into the
  shell on reconnect
- **Post-connect command sets** — per-target lists that run on login
  (jump-host hops, `su - deploy`, …). An inline `> @name=secret` line is
  stripped into the keyring on save and answered by reference; anything
  else is asked in a dialog. Progress is shown per line, and on the web a
  line stuck waiting for input can be resumed by hand.
- A password you type by hand is offered for remembering once it verifies;
  nested `ssh` / `sudo` / `su` prompts then fill themselves in from the
  keyring

**Safety** — details in [Security model](#security-model)

- Three-tier command policy (auto / approve / deny) enforced as agent
  middleware, plus custom exact-match rules (`auto_extra` / `approve_extra`
  / `deny_extra`)
- Every input, command, approval, and summary lands in a JSONL transcript
  under `~/.openterminal/sessions/`

**Web UI** (`ot web`)

- Server sidebar + multi-tab terminals; Agent view and plain Shell view
  per tab, each tab showing its own connection status
- Browser-dialog password and host-key entry; optional LAN access with a
  mandatory token for non-loopback binds

**Headless / scripting**

- `ot exec -t <target> -c "<cmd>" --output json` — one policy-gated
  command per invocation, with machine-readable output and exit codes
  (`APPROVAL_REQUIRED` / `DENIED` / `HOST_KEY_UNKNOWN`), safe to wire
  into cron or CI
- `ot list targets --output json`

**Model gateways**

- Any Anthropic-compatible or OpenAI-compatible gateway — protocol, base
  URL, model, and key env var all configurable
- The web model picker reads its options from `[model] models`

## Installation

Pick whichever suits you — a pre-built binary (no Python needed), a package
manager, or from source.

### Pre-built binaries (macOS & Windows)

Download from [Releases](https://github.com/jeean404/OpenTerminal/releases),
unpack, and put the `ot` executable on your `PATH`. Replace `vX.Y.Z` with the
latest tag:

| Platform | Asset |
|---|---|
| macOS (Apple Silicon) | `ot-vX.Y.Z-macos-arm64.tar.gz` |
| macOS (Intel) | `ot-vX.Y.Z-macos-x86_64.tar.gz` |
| Windows (x64) | `ot-vX.Y.Z-windows-x64.zip` |

```sh
# macOS
tar -xzf ot-vX.Y.Z-macos-arm64.tar.gz
sudo mv ot/ot /usr/local/bin/ot        # or any directory on your PATH
```

On Windows, unzip and add the `ot` folder to your `PATH`, then run `ot.exe`.

> **Intel Macs**: GitHub retired its Intel macOS runners, so the x86_64 binary
> is built and attached manually per release. If a release is missing it,
> install from PyPI with `pipx install open-terminal-agent` (see below), which works
> on both architectures.

> **macOS Gatekeeper** — the binaries are ad-hoc signed (not notarized), so
> the first launch may be blocked with *“ot cannot be opened.”* Clear the
> quarantine flag once with `xattr -cr "$(command -v ot)"`, or right-click →
> Open. The first run also triggers a one-time OS security scan; later runs
> start in under a second (the AI stack is loaded lazily on the first AI
> task, which takes a few extra seconds once).

> **Windows SmartScreen** — you may see *“Windows protected your PC”* (the
> binary is unsigned). Click **More info → Run anyway**.

### pipx / uv (from PyPI)

The Python package is `open-terminal-agent` (it installs the `ot` command):

```sh
pipx install open-terminal-agent
# or
uv tool install open-terminal-agent
```

Requires Python 3.11+.

### From source (development)

```sh
conda create -n openterminal python=3.12 -y   # or any virtualenv
conda activate openterminal
pip install -e .
```

Then set up your model gateway (see below) and run it:

```sh
mkdir -p ~/.openterminal && cp .env.example ~/.openterminal/.env
# edit ~/.openterminal/.env — point it at a model gateway
```

## Quick start

```sh
ot          # terminal — local shell + main menu (connect / manage hosts)
ot web      # browser terminal — server sidebar + multi-tab UI (default http://127.0.0.1:8080)
```

More ways to connect:

```sh
ot connect prod-web      # a host from ~/.ssh/config
ot ssh deploy@host:2222  # or user@host:port directly
```

## Model gateway configuration

OpenTerminal talks to any Anthropic-compatible gateway. On startup it loads
`.env` from the current directory, then `~/.openterminal/.env`, then
`~/.openterminal/config.toml`. **None of these are required** — defaults:

- Protocol: `anthropic` (default) or `openai` (OpenAI-compatible protocol)
- Gateway: `http://127.0.0.1:15721` (Anthropic-compatible protocol; the `openai`
  provider defaults to the official endpoint)
- Model: `claude-sonnet-4-6` (`gpt-5` under the `openai` provider)
- API key: from the `ANTHROPIC_API_KEY` environment variable
  (`OPENAI_API_KEY` under the `openai` provider)

Optional `~/.openterminal/config.toml` (every field may be omitted):

```toml
[model]
provider = "anthropic"       # anthropic | openai (OpenAI-compatible protocol)
base_url = "http://127.0.0.1:15721"
model = "claude-sonnet-4-6"
api_key_env = "ANTHROPIC_API_KEY"
models = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"]  # web model picker

# OpenAI-compatible protocol example (any OpenAI-compatible gateway works;
# the defaults of the fields above switch to an openai set with the
# provider — explicit fields always win):
# provider = "openai"
# base_url = "https://api.openai.com/v1"
# model = "gpt-5"
# api_key_env = "OPENAI_API_KEY"

[shell]
timeout_default = 120        # per-command wait budget (seconds)
max_output_bytes = 102400    # per-command output truncation
max_tool_turns = 10          # agent tool-call turn budget

[policy]
mode = "tiered"              # tiered | approve-all | deny-all
# auto_extra / approve_extra / deny_extra append exact-match custom rules

[target.prod-web]
mode = "ssh"
host = "prod-web.example.com"
user = "deploy"
# Post-connect command set — runs line by line right after login.
# A "> @name=secret" line stores the secret in the keyring and is kept as
# "> @name"; the password box then answers from that reference.
commands = [
  "su - deploy",
  "> @deploy_pw",
]
```

Config directory can be moved with `OPENTERMINAL_HOME` (the test suite uses
this for isolation). Transcripts go to `~/.openterminal/sessions/`; host
profiles are cached in `~/.openterminal/hosts.toml`.

## Day-to-day use

**In the terminal** — just type. A normal sentence becomes a task; a plain
command runs in your real shell. `!` forces a command, `?` forces a task.
`/help` lists the slash commands: `/target` switch host, `/system` override
the detected dialect, `/clear` new task, `/model` show model, `/exit` quit.
Ctrl+C interrupts a running task and returns you to the prompt.

**Post-connect command sets** run themselves the moment a target is up —
handy for jump hosts and `su -` switches. Keep a password out of the file by
writing `> @name=secret` once; the stored line is just `> @name` and the
prompt is answered from the keyring. If a line stops to ask for something,
the web status bar offers a Resume button instead of leaving you stuck
(the terminal CLI has no resume entry yet).

**In the browser** (`ot web`) — pick a server from the sidebar (local or
direct SSH), open as many tabs as you like, and work in the Agent view or
plain Shell view. Passwords and host keys are entered in browser dialogs;
remembered passwords go through the OS credential store, so reconnecting is
password-free.

**LAN access**: `ot web --host 0.0.0.0 --token <TOKEN>` — a token is
mandatory for non-loopback binds. Config: `[web] host/port/token` in
`config.toml`.

**In scripts**: `ot exec` runs one command against a target behind the
same policy gate and speaks JSON — read-only commands execute; anything
needing approval exits with `APPROVAL_REQUIRED` (67) instead of running,
and refused commands exit with `DENIED` (66), so automation can react
instead of guessing:

```sh
ot exec -t prod-web -c "df -h /" --output json
```

## Security model

The rule of thumb: **looking is free; changing things needs your OK; disasters
are refused.**

Three tiers (`src/openterminal/policy.py`):

- **auto** — read-only stuff runs on its own: `ls`/`cat`/`df`/`ps`,
  `git status/log`, `find` without `-exec/-delete`, …
- **approve** — anything that modifies the system: deleting files, writing
  files, installing packages, `systemctl`, `sudo`, network config, plus
  anything the static rules can't confidently judge. A panel opens:
  `y` execute / `e` edit / `n` reject / `a` allow for this session (in the
  web UI it's a button, with a second confirm for high-risk commands).
- **deny** — the catastrophic stuff is refused and the reason is fed back to
  the model so it changes course: `rm -rf /`, mkfs, `dd` to block devices,
  fork bombs, shutdown, redirects to /dev devices, …

Rejected and failed commands aren't retried verbatim: the agent is prompted
to retry a failure at most once and never re-skin a rejected command, and
tool-call turns are budget-bounded.

## Architecture

<div align="center">
  <img src="docs/images/architecture.svg" width="860" alt="OpenTerminal architecture">
</div>

Full docs: [Architecture](docs/architecture.md) · [Design notes](docs/design.md) ·
[Flow diagrams](docs/flows.md)

Three layers: the natural-language front end (terminal or web), a
deepagents (LangGraph) agent, and persistent shell sessions. Natural
language goes straight to the agent for multi-turn tool use; command
execution is a sub-capability of the agent, over the same session. The
tiered policy is enforced as agent middleware, so the approval gate can't
be bypassed by prompt content. Built-in skills are mounted as files under
`/skills/`, so the agent loads them the same way it loads any other
reference file.

Display is a **single pipeline**: PTY bytes go straight to the terminal,
shell-integration hooks keep the books via in-band OSC markers (history /
exit codes / AI context), and agent tool commands are injected into the
same PTY via `__ot_exec__`, so their output lands in place. A per-session
lock keeps commands strictly serial — one PTY is one interactive shell, so
concurrent agent `execute` calls queue up. BEGIN/END sentinel slicing
(`shell_session.py`) remains only for non-display paths such as headless
`ot exec` and capability probes.

There is **no model-level long-term memory** — the agent's checkpointer is
in-memory and cleared on restart. What persists is factual state:

| Store | Location | Contents |
|---|---|---|
| Config | `~/.openterminal/config.toml` | gateway / shell budgets / policy / targets |
| Connections | `~/.openterminal/connections.db` | remembered connections and their command sets |
| Command history | `~/.openterminal/history.db` | per-target history, replayed into the shell on reconnect |
| Passwords | OS credential store (keyring) | connection passwords and command-set secrets — never written to plaintext files |
| Host profiles | `~/.openterminal/hosts.toml` | per-host system profile cache |
| Transcripts | `~/.openterminal/sessions/<date>/` | JSONL of inputs/commands/approvals/summaries |
| Host keys | `~/.ssh/known_hosts` | written after TOFU confirmation |

## Testing

```sh
pytest -q                      # Python suite (platform-gated tests auto-skip)
node --test tests/js/*.test.cjs                        # static frontend
cd src/openterminal/web/frontend/ui && npm ci && npm test  # React island
```

Real-sshd tests are opt-in:

```sh
OT_TEST_SSH=1 OT_TEST_SSH_HOST=127.0.0.1 OT_TEST_SSH_PORT=2222 pytest -m ssh
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome.

## Acknowledgments

- [deepagents](https://github.com/langchain-ai/deepagents) & LangGraph — agent runtime
- [xterm.js](https://xtermjs.org/) — browser terminal (vendored in `web/frontend/vendor/`)
- [asyncssh](https://github.com/ronf/asyncssh) — SSH client

## License

[Apache License 2.0](LICENSE)
