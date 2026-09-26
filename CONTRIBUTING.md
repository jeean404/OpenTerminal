# Contributing to OpenTerminal

Thanks for your interest in contributing! Issues, bug reports, and pull
requests are all welcome. (中文贡献指南待补充,欢迎 PR。)

## Development setup

```sh
git clone https://github.com/JaquariusJ/OpenTerminal.git
cd OpenTerminal
conda create -n openterminal python=3.12 -y && conda activate openterminal
pip install -e ".[dev]"
```

## Running the tests

```sh
pytest -q                    # Python test suite (platform-gated tests auto-skip)
node --test tests/js/*.test.cjs   # static frontend tests (Node 18+)
cd src/openterminal/web/frontend/ui && npm ci && npm test   # React island tests
```

CI runs all three on every push and pull request. Real-sshd tests are
opt-in and run locally only:

```sh
OT_TEST_SSH=1 OT_TEST_SSH_HOST=127.0.0.1 OT_TEST_SSH_PORT=2222 pytest -m ssh
```

## Pull requests

- Keep PRs focused: one fix or feature per PR.
- Add or update tests for behavior changes. Pure-logic tests should run on
  every platform; gate real-PTY / real-SSH coverage behind the existing
  markers and environment flags.
- Match the surrounding code style. Comments and user-facing strings are
  mostly Chinese in this codebase — either language is fine, stay consistent
  within the file you're touching.
- For changes to the web frontend's React island, rebuild is done by
  `npm run build` inside `src/openterminal/web/frontend/ui`; commit the
  rebuilt `static/ui/` output together with the source change.

## Security-sensitive changes

OpenTerminal executes commands on real machines. If your PR touches
`policy.py`, `approval.py`, `shell_session.py`, `agent.py`, or anything
handling credentials, please:

- explain the security implications in the PR description;
- add tests covering the new allow/deny/approve behavior;
- never hardcode hostnames, passwords, or API keys in tests or fixtures —
  use environment variables (see the existing `OT_TEST_*` convention).

## Reporting vulnerabilities

Please do **not** open a public issue for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for how to report them privately.

## License

By contributing, you agree that your contributions will be licensed under
the [Apache License 2.0](LICENSE) that covers this project.
