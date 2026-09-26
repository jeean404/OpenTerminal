# OpenTerminal

[![CI](https://github.com/JaquariusJ/OpenTerminal/actions/workflows/ci.yml/badge.svg)](https://github.com/JaquariusJ/OpenTerminal/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[中文文档](README.zh-CN.md)

Type natural language in your own terminal — OpenTerminal translates it into
commands for the target system, executes them, and reports back. Built-in
remote connections mean you don't need Xshell. Powered by
[deepagents](https://github.com/langchain-ai/deepagents) (LangGraph).

> ⚠️ **Beta**: OpenTerminal runs real commands on real machines — including
> your production servers. The approval system (see [Security model](#security-model))
> gates every state-changing command, but review what it approves carefully.

## Features

- **Natural language ↔ command discrimination** — plain commands run directly,
  tasks are handed to the Agent
- **Persistent shell** — `cd` / exports / venv state survives across commands;
  Linux & macOS local (POSIX PTY), Windows local (ConPTY / PowerShell), SSH remote Linux
- **System profiling & dialect translation** — Ubuntu→apt, CentOS 7→yum,
  Rocky/Fedora→dnf, Alpine→apk, macOS→brew
- **Tiered approval** — read-only runs automatically, destructive commands
  require approval, catastrophic commands are refused; failed attempts get a
  bounded self-correction budget (10 turns)
- **Raw passthrough mode** — Ctrl+R hands the terminal to vim/top/tmux, Ctrl+O
  returns; SSH and jump hosts (`~/.ssh/config`) built in
- **Windows client** — connect to remote Linux from Windows
- **Web terminal** (`ot web`) — browser UI with a server sidebar and multi-tab
  terminals, sharing the same agent core

## Installation

Requires Python 3.10+.

```sh
# conda (or any virtualenv)
conda create -n openterminal python=3.12 -y
conda activate openterminal
pip install -e .
mkdir -p ~/.openterminal && cp .env.example ~/.openterminal/.env
# edit ~/.openterminal/.env and config.toml (model gateway)
```

## Model gateway configuration

On startup OpenTerminal loads `.env` from the current directory, then
`~/.openterminal/.env`, then reads `~/.openterminal/config.toml`. **Neither
file is required** — built-in defaults apply when they're missing:

- Gateway: `http://127.0.0.1:15721` (Anthropic-compatible protocol)
- Model: `claude-sonnet-4-6`
- API key: read from the `ANTHROPIC_API_KEY` environment variable

Optional `~/.openterminal/config.toml` (every field may be omitted):

```toml
[model]
base_url = "http://127.0.0.1:15721"
model = "claude-sonnet-4-6"
api_key_env = "ANTHROPIC_API_KEY"

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
```

The config directory can be overridden with the `OPENTERMINAL_HOME`
environment variable (used by the test suite for isolation). Session
transcripts are written to `~/.openterminal/sessions/`; remote host profiles
are cached in `~/.openterminal/hosts.toml`.

## Usage

```sh
ot                       # main menu: connect / manage hosts / quit (arrow keys)
ot connect prod-web      # a host from ~/.ssh/config
ot ssh deploy@host:2222  # or user@host:port directly
```

The main menu lists connectable targets: `local`, remembered connections,
jump-host targets (as sublists). Adding / editing / deleting hosts and jump
hosts is done under "Manage hosts". Remembered connections live in
`~/.openterminal/connections.toml` (private to your machine, never committed).
Passwords are stored in the **OS credential store** (Windows Credential
Manager / macOS Keychain / Linux Secret Service, via
[keyring](https://pypi.org/project/keyring/)) so the next login is
password-free; without a usable credential store you're prompted each time.

REPL: type commands or describe a task; `!` forces a command, `?` forces a
task; `/target` switch host, `/system` manual dialect, `/clear` new task,
`/model` show model, `/exit` quit; Ctrl+R raw passthrough, Ctrl+O back.

### Output presentation

Output is grouped into panels, cloud-console style:

- Model thinking streams live into a dedicated **💭 Thinking** panel;
- Commands appear in an **Execution** panel with output passed through
  verbatim; a non-zero exit only adds an exit-code note — it is *not* treated
  as failure (probe commands legitimately exit non-zero, e.g. `command -v`,
  `grep` with no match);
- The final summary gets its own **📝 Summary** panel; rejections and budget
  exhaustion append a reason line.

## Security model

Core principle: **operations that only look are executed automatically; any
operation that changes the server must be approved by you; catastrophic
commands are refused outright.**

Three-tier command policy (`src/openterminal/policy.py`):

- **auto** — read-only commands (ls/cat/pwd/df/ps, queries like
  `ip addr show`, `git status/log`, find without -exec/-delete, …)
- **approve** — destructive: file deletion (rm/rmdir), anything that modifies
  the server (writes/redirects, mv/mkdir/touch, package install/uninstall,
  systemctl operations, sudo elevation, network config, hostname changes,
  `git config` writes, …), plus anything that can't be statically judged —
  an approval panel opens with `y` execute / `e` edit / `n` reject /
  `a` always allow this session
- **deny** — catastrophic commands are refused and the reason is fed back to
  the model (`rm -rf /`, mkfs, dd to block devices, fork bombs, shutdown,
  redirects to /dev devices, …), forcing the model to find another way

Rejections and failures are not retried verbatim: the agent's system prompt
forbids retrying a failed command more than once and re-skinning rejected
commands; consecutive tool calls are bounded by the turn budget.

## Web terminal (`ot web`)

`ot web` starts a local web terminal: server sidebar (local / direct / via
jump host) on the left, multi-tab browser terminals on the right, with the
same core capabilities as the CLI (natural-language tasks, tiered approval,
💭/⚙/📝 panels). Binds `http://127.0.0.1:8080` by default and opens the browser.

- One ShellSession + one Agent per tab; `Ctrl+R` or a button toggles
  passthrough mode (vim/top)
- Passwords / host keys are entered via browser dialogs; remembered passwords
  still go through the OS credential store
- LAN access: `ot web --host 0.0.0.0 --token <TOKEN>` (a token is mandatory
  for non-loopback binds)
- Config: `[web] host/port/token` in `~/.openterminal/config.toml`
- Interactive commands (`su`, `sudo su -`, `sudo -i`, …) are classified as
  passthrough operations; sudo/password prompts are detected immediately
  instead of dying after a 120 s timeout

## Jump hosts

Jump hosts are managed centrally under "Manage hosts" (stored in
`connections.toml` as `[[jumps]]`); hosts can reference a jump host when
added or edited. Connecting via a jump host proxies first to the jump, then
tunnels to the target (password-authenticated jumps work too; remembered
jump passwords use the credential store as well).

## Architecture

Three layers: natural-language REPL + deepagents (LangGraph) agent +
persistent shell sessions. Input is classified by intent: direct commands go
to the session executor, tasks go to the agent for multi-turn tool use; the
tiered command policy (auto/approve/deny) is enforced at the agent
middleware layer.

```
┌───────────────────────────────────────────────────────────┐
│ Entry  src/openterminal/app.py                             │
│   ├─ Cli (cli.py): prompt_toolkit + rich REPL loop         │
│   │    ├─ intent.py      command vs. task classification   │
│   │    ├─ agent.py       deepagents wiring / TaskRunner    │
│   │    ├─ policy.py      command tiering (auto/approve/deny)│
│   │    ├─ backend.py     PtyShellBackend: session→agent    │
│   │    └─ connections.py target listing / session factory  │
│   └─ web/: FastAPI + TabWorker browser terminal (`ot web`) │
└───────────────────────────┬───────────────────────────────┘
                            │ open_session
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
  local_pty.py        local_win.py          ssh_pty.py
  POSIX PTY           Windows ConPTY        asyncssh (jump tunnel)
        └────────────── shell_session.py ────┘
        BasePtySession: sentinel capture main loop
        (BEGIN/END markers, timeout, truncation, reconnect,
         password-prompt fallback)

  Support: sysprobe.py host profiling | secrets_store.py OS keyring |
        transcript.py session JSONL | config.py configuration |
        render.py / taskview.py / approval.py / rawmode.py (CLI display)
```

Key modules:

| Module | Responsibility |
|---|---|
| app.py | entry point: load .env / config.toml; `ot connect/ssh` or the menu |
| cli.py | REPL loop: input triage, `/` commands, target switching, approvals, raw mode |
| intent.py | command vs. task classification (rules + LLM fallback; `!`/`?` force) |
| agent.py | `create_deep_agent` wiring, system prompt (dialect table), TaskRunner, Deny / human-in-the-loop middleware |
| policy.py | static command tiering: read-only auto, mutating approve, disaster deny |
| backend.py | PtyShellBackend: file ops reuse LocalShellBackend, execute runs the persistent PTY session |
| connections.py | targets (local / ssh_config / remembered / jump hosts) and the `open_session` factory |
| shell_session.py | BasePtySession: sentinel capture, timeout interrupts, output truncation, reconnect, password-prompt fallback |
| local_pty.py / local_win.py | POSIX PTY / Windows ConPTY (PowerShell) session implementations |
| ssh_pty.py | asyncssh remote sessions: jump-then-tunnel, TOFU host keys |
| sysprobe.py | probe the target's system profile (distro / package manager / init), cached in hosts.toml |
| secrets_store.py | connection passwords via keyring → Credential Manager / Keychain / Secret Service |
| transcript.py | session records: `~/.openterminal/sessions/<date>/<id>.jsonl` |
| rawmode.py | Ctrl+R raw passthrough mode (vim/top/tmux) |
| render.py / taskview.py / approval.py | rich panels, task view / thinking stream, approval helpers |
| web/ | `ot web`: FastAPI server, per-tab worker, WS protocol, browser frontend (xterm.js) |

Command output is delimited with BEGIN/END sentinels (`shell_session.py`)
and tee'd live to the display layer; a per-session lock keeps commands
strictly serial — one PTY is one interactive shell, so concurrent agent
`execute` calls queue up.

There is **no model-level long-term memory**: the agent's checkpointer is an
in-memory `MemorySaver()`. What persists is factual data:

| Store | Location | Contents |
|---|---|---|
| Config | `~/.openterminal/config.toml` | gateway / shell budgets / policy / targets |
| Connections | `~/.openterminal/connections.toml` | remembered connections + jump hosts |
| Passwords | OS credential store (keyring) | never written to plaintext files |
| Host profiles | `~/.openterminal/hosts.toml` | per-host system profile cache |
| Transcripts | `~/.openterminal/sessions/<date>/` | JSONL of inputs/commands/approvals/summaries |
| Host keys | `~/.ssh/known_hosts` | written after TOFU confirmation |

## Testing

```sh
pytest -q
```

Skipped tests are platform/environment-gated (POSIX-only local PTY tests on
Windows, real-sshd tests, …). The sshd-gated tests need an explicit opt-in:

```sh
# with a key-auth sshd running locally:
OT_TEST_SSH=1 OT_TEST_SSH_HOST=127.0.0.1 OT_TEST_SSH_PORT=2222 pytest -m ssh
```

Frontend unit tests (no browser needed):

```sh
node --test tests/js/*.test.cjs                         # static frontend
cd src/openterminal/web/frontend/ui && npm ci && npm test  # React island
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome.

## Acknowledgments

- [deepagents](https://github.com/langchain-ai/deepagents) & LangGraph — agent runtime
- [xterm.js](https://xtermjs.org/) — browser terminal (vendored in `web/frontend/vendor/`)
- [asyncssh](https://github.com/ronf/asyncssh) — SSH client

## License

[Apache License 2.0](LICENSE)
