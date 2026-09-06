# Architect workflow verification

Use a separate Paseo home and daemon endpoint. Keep existing credentials in their current locations; do not change `HOME` or the normal daemon.

Run from this repository:

```bash
export ARCHITECT_REPO="$PWD"
export ARCHITECT_SCRATCH="$(mktemp -d /tmp/paseo-architect.XXXXXX)"
export PASEO_HOME="$ARCHITECT_SCRATCH/paseo"
export PASEO_HOST="127.0.0.1:16867"
mkdir -p "$PASEO_HOME" "$ARCHITECT_SCRATCH/repos"
printf '{"pluginsEnabled":true}\n' > "$PASEO_HOME/config.json"
python3 -m venv runtimes/python/.venv
runtimes/python/.venv/bin/pip install -e './runtimes/python[dev]'
npm ci --prefix paseo-plugin
paseo daemon start --home "$PASEO_HOME" --listen "$PASEO_HOST" --no-relay --no-inject-mcp --web-ui
paseo plugin install "$ARCHITECT_REPO/paseo-plugin"
```

Search credentials may be supplied through `BRAVE_API_KEY` and `EXA_API_KEY`, or a private `$PASEO_HOME/architect/credentials.yaml` (override its path with `ARCHITECT_CREDENTIALS`). Pass any required environment into the scratch daemon before it starts. The host stores its SQLite database, diagnostic artifacts, and endpoint metadata beneath `$PASEO_HOME/architect`; implementer worktrees belong beneath this same home. Native Teacher state is isolated there too; its authentication is copied from the existing Grok login without inheriting user plugins or repository MCP configuration.

Create a disposable repository for each routing scenario:

```bash
git init -b main "$ARCHITECT_SCRATCH/repos/bounded"
git -C "$ARCHITECT_SCRATCH/repos/bounded" config user.name 'Architect verification'
git -C "$ARCHITECT_SCRATCH/repos/bounded" config user.email 'architect-test@example.invalid'
printf 'one\n' > "$ARCHITECT_SCRATCH/repos/bounded/example.txt"
git -C "$ARCHITECT_SCRATCH/repos/bounded" add example.txt
git -C "$ARCHITECT_SCRATCH/repos/bounded" commit -m 'Test baseline'
```

Use additional disposable repositories for open review, remaining findings, and divergent local-main tests. Use an explicitly identified test remote for publication checks. Record actual runtime requests/session artifacts, committed SHAs, and PR URLs in `.architect/artifacts/` without credentials.

```bash
npm test
npm run test:python
npm run typecheck
paseo plugin reload architect
```

Cleanup only after all scratch workers have finished or been explicitly cancelled. The independent Architect host survives plugin reloads; terminate that scratch host before removing its state:

```bash
paseo daemon stop --home "$PASEO_HOME"
zg server off --home "$PASEO_HOME/architect/zg"
python3 - <<'PY'
import json, os, pathlib, signal
meta = pathlib.Path(os.environ['PASEO_HOME']) / 'architect' / 'host.json'
if meta.exists():
    pid = json.loads(meta.read_text())['pid']
    cmdline = pathlib.Path(f'/proc/{pid}/cmdline')
    if cmdline.exists() and b'host-process.mjs' in cmdline.read_bytes():
        os.kill(pid, signal.SIGTERM)
PY
# Inspect the directory and preserved work before removing this disposable tree.
rm -rf -- "$ARCHITECT_SCRATCH"
unset PASEO_HOME PASEO_HOST ARCHITECT_SCRATCH ARCHITECT_REPO
```
