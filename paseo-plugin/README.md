# Paseo Architect

The Architect collaborates with the operator on `.architect/ticket.md`, using Astra high and retaining the current and previous exchanges. Teacher, Implementer and Researcher use Grok 4.6 high. Bounded work lands directly; open work receives an immutable-revision OCR review, at most one correction in the same worktree, and a second review before landing.

The Implementer runs the pinned upstream Mini v2 loop. Teacher uses Grok's native profile and conversation management in an isolated Grok home, with five repository tools. Researcher uses smolagents and a validated completion envelope. No QQ or DSH runtime is required.

## Install and verify

Requires Node with `node:sqlite`, Python 3.10+, Paseo 0.7.2, the Grok CLI, `zg`, Git, GitHub CLI, and OCR 1.11.5. Sign in to Codex/Grok or supply the provider credentials. Supply `BRAVE_API_KEY` and/or `EXA_API_KEY`, or put them in a private `$PASEO_HOME/architect/credentials.yaml`. `ARCHITECT_CREDENTIALS` selects a different credential file. `GROK_TOKEN_HELPER` may select an existing token helper.

```bash
npm ci --prefix paseo-plugin
python3 -m venv mini-researcher/.venv
mini-researcher/.venv/bin/pip install -e './mini-researcher[dev]'
npm run typecheck --prefix paseo-plugin
paseo plugin install "$PWD/paseo-plugin"
paseo plugin reload architect
```

Use the repository's [scratch recipe](../.architect/scratch.md) to verify in a separate Paseo home and disposable repositories. Other repositories can opt in by providing their own `.architect/scratch.md`; the workflow does not provision a generic environment.

## Durable state

The independent host keeps `state.sqlite`, endpoint metadata, diagnostic artifacts and native Teacher state under the selected `$PASEO_HOME/architect`. Completion returns a durable, idempotent receipt before host-owned review or publication. Wakes remain in the acknowledged outbox until Architect finishes processing them. Plugin reload does not stop the host or its children. A changed host drains existing jobs before upgrading; surviving children keep the same endpoint across host recovery.

Each model request and command has an attempt journal. Recovery allows three provider attempts, one malformed-output repair, one known-safe process restart, and six recovery actions across the delegation and correction cycle. Provider circuits and repetition histories persist. The host diagnoses missing heartbeats without replacing a worker. Interrupted commands or publication with unknown outcomes are preserved for inspection and never automatically replayed.

A remote landing identifies and pushes the exact branch, identifies the PR explicitly, checks its reviewed head, and verifies the merged commit on the remote base. Without a remote, landing requires a fast-forward onto local `main` or `master`; divergence remains intact.

## Checks

```bash
npm run test:architect
npm test
mini-researcher/.venv/bin/pytest -q mini-researcher/tests
npm run typecheck --prefix paseo-plugin
LIVE_ARCHITECT=1 node tests/paseo-architect/live.mjs
```

See [verification evidence](../.architect/verification.md) for real runtime and UI checks. Runtime databases and raw provider responses contain conversation data; keep them local. Credentials are never included in the verification report.
