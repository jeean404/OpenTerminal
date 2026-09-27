# OpenTerminal

[![CI](https://github.com/JaquariusJ/OpenTerminal/actions/workflows/ci.yml/badge.svg)](https://github.com/JaquariusJ/OpenTerminal/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[中文文档](README.zh-CN.md)

**Tell your terminal what you want in plain language — it does the work.**

OpenTerminal lives in your terminal (and your browser). Type a normal sentence
like *"check which files are eating the most space"* and it figures out the
right commands, runs them, and sums up the results. Plain commands still work
exactly as you'd expect. It can hop to your remote servers over SSH too, so
you can leave Xshell behind.

<div align="center">
  <img src="docs/images/demo-web.gif" width="860" alt="OpenTerminal demo: natural language task → analysis → approval → execution → summary">
</div>

Here's what happens in the demo above:

1. You type **"在 /tmp 下新建一个名叫 ot-demo 的文件夹"** (plain language);
2. The AI first shows its **analysis** — what it's about to do and why;
3. Creating a folder changes the system, so an **approval panel** pops up — nothing runs without your OK;
4. You hit **执行 (Execute)** — the command runs with its output shown verbatim;
5. A **summary** card wraps up what was done.

> ⚠️ **Beta**: OpenTerminal runs real commands on real machines — including
> production servers. Every state-changing command needs your approval (see
> [Security model](#security-model)), but please still read what you're approving.

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

## Quick start

Requires Python 3.10+.

```sh
# conda (or any virtualenv)
conda create -n openterminal python=3.12 -y
conda activate openterminal
pip install -e .
mkdir -p ~/.openterminal && cp .env.example ~/.openterminal/.env
# edit ~/.openterminal/.env — point it at a model gateway (see below)
```

Then:

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

- Gateway: `http://127.0.0.1:15721` (Anthropic-compatible protocol)
- Model: `claude-sonnet-4-6`
- API key: from the `ANTHROPIC_API_KEY` environment variable

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

Config directory can be moved with `OPENTERMINAL_HOME` (the test suite uses
this for isolation). Transcripts go to `~/.openterminal/sessions/`; host
profiles are cached in `~/.openterminal/hosts.toml`.

## Day-to-day use

**In the terminal** — just type. A normal sentence becomes a task; a plain
command runs in your real shell. `!` forces a command, `?` forces a task.
`/target` switch host, `/system` override the detected dialect, `/clear`
new task, `/model` show model, `/exit` quit. Ctrl+C interrupts a running
task and returns you to the prompt.

**In the browser** (`ot web`) — pick a server from the sidebar (local,
direct, or via jump host), open as many tabs as you like, and work in the
Agent view or plain Shell view. Passwords and host keys are entered in
browser dialogs; remembered passwords go through the OS credential store, so
reconnecting is password-free.

**LAN access**: `ot web --host 0.0.0.0 --token <TOKEN>` — a token is
mandatory for non-loopback binds. Config: `[web] host/port/token` in
`config.toml`.

**Jump hosts** are managed under "Manage hosts" in the UI (stored in
`~/.openterminal/connections.toml` as `[[jumps]]`). Connecting through one
hops first to the jump, then tunnels to the target — password-authenticated
jumps work, and remembered jump passwords use the credential store too.

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

Three layers: the natural-language front end (terminal or web), a
deepagents (LangGraph) agent, and persistent shell sessions. Natural
language goes straight to the agent for multi-turn tool use; command
execution is a sub-capability of the agent, over the same session. The
tiered policy is enforced as agent middleware, so the approval gate can't
be bypassed by prompt content.

Command output is delimited with BEGIN/END sentinels (`shell_session.py`)
and streamed live to the UI; a per-session lock keeps commands strictly
serial — one PTY is one interactive shell, so concurrent agent `execute`
calls queue up.

There is **no model-level long-term memory** — the agent's checkpointer is
in-memory and cleared on restart. What persists is factual state:

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
