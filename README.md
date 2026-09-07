# Paseo Architect

Paseo Architect is a plugin for [Paseo](https://paseo.sh/) that helps you plan and implement changes to a software project. You work with a planning agent to define the problem, make decisions and write a ticket. When the ticket is ready, it delegates the work to agents that can research questions, explain unfamiliar concepts and implement the change.

The ticket stays in your repository at `.architect/ticket.md`, where you can read and edit it. It records the decisions and requirements the agents need to carry the work forward.

## How it works

1. **Plan together.** Describe the change you want. Architect asks questions, investigates the code and records the scope and testing plan in the ticket.
2. **Resolve questions.** Researcher finds answers with sources. If you want help understanding a decision, Teacher opens a separate conversation so you can learn enough to choose.
3. **Implement.** Once the ticket is ready, Implementer works in a separate Git worktree—a checkout with its own branch—so you can follow its progress independently.
4. **Review and merge.** Straightforward work marked **bounded** proceeds directly to merging. Work marked **open**, which leaves implementation decisions to the agent, gets an automated code review and up to one correction pass. Unresolved findings return to Architect for discussion.

For a repository with a GitHub remote, the workflow pushes the implementation branch, creates a pull request and merges it automatically. The GitHub account must have permission to do so. Without a remote, it updates local `main` or `master` only when a fast-forward is possible; if the branches have diverged, it stops and preserves the work.

## Before you install

Install the plugin on the machine running your Paseo daemon. You will need:

| Requirement | Used for |
| --- | --- |
| [Paseo](https://paseo.sh/) with plugins enabled | Conversations, workspace UI and agent sessions; tested with 0.7.2 |
| Node.js with the built-in `node:sqlite` module, and Python 3.10+ | Running the plugin and its agents |
| Git and [GitHub CLI](https://cli.github.com/) (`gh`) | Worktrees and pull-request creation/merging |
| [Grok CLI](https://github.com/xai-org/grok-build), signed in | Teacher conversations |
| [zvec-grep](https://github.com/zvec-ai/zvec-grep) (`zg`) | Repository search; tested with 0.2.1 |
| [Open Code Review](https://github.com/alibaba/open-code-review) (`ocr`) | Automated code review; tested with 1.11.5 |

The agents are currently configured for **GPT-6 Astra** and **Grok 4.6**, both with high reasoning. Your provider accounts must have access to those models. Architect reads an existing Codex login or `OPENAI_API_KEY`. Researcher, Implementer and code review use `XAI_API_KEY`; an existing Grok token helper can also supply their token. Teacher uses the Grok CLI login. If Grok is installed outside `~/.grok/bin/grok`, set `GROK_BIN` to its executable. Sign in to the GitHub CLI on the same machine with `gh auth login`.

Make credentials available to the Paseo daemon before starting the plugin. Setting variables in a new terminal does not update an already-running daemon's environment. For a separate test instance, follow the [isolated setup guide](.architect/scratch.md).

## Install

Enable plugins in Paseo's **Settings → Plugins**. Then clone this repository into a location you intend to keep and install its dependencies:

```bash
git clone https://github.com/hypermemetic-ai/qq-workflows.git
cd qq-workflows
npm ci --prefix paseo-plugin
python3 -m venv runtimes/python/.venv
runtimes/python/.venv/bin/pip install -e './runtimes/python[dev]'
npm run typecheck
paseo plugin install "$PWD/paseo-plugin"
paseo plugin ls
```

The plugin ID is `architect`; it should appear as **running**. Paseo loads it from this checkout, so keep the directory in place. If you use several daemons, set `PASEO_HOME` and `PASEO_HOST` to select the intended one before running the installation commands. See [Paseo's plugin documentation](https://paseo.sh/docs/plugins/v0.7) for host and plugin management.

### Enable web research

For web search, provide a Brave or Exa API key. You can use the daemon's `BRAVE_API_KEY` and `EXA_API_KEY` environment variables, or create a private `architect/credentials.yaml` inside the Paseo home directory. With the default home, that file is `~/.paseo/architect/credentials.yaml`:

```yaml
BRAVE_API_KEY: your-brave-key
EXA_API_KEY: your-exa-key
```

Include the keys you have and restrict access to the file with `chmod 600`. Keep credentials outside your project repository. `ARCHITECT_CREDENTIALS` can select another file; `GROK_TOKEN_HELPER` can select an existing token-helper executable.

## Start your first change

1. Open the project you want to change as a workspace in Paseo.
2. Open the command center (⌘K on macOS or Ctrl+K on Windows/Linux) and choose **Start architect**.
3. Describe the problem and what a successful result would look like. For example: “The CSV import accepts duplicate rows. Help me decide how duplicates should be handled, then implement and test it.”
4. Follow the discussion in the Architect conversation and the plan in the **Ticket** panel. If Architect starts a Teacher session, open it to discuss the decision, then return to Architect.

The ticket is created automatically. Tap **Ticket** beside the composer in an Architect conversation, or a recovery conversation in the same checkout. The panel has **Plan** and **Delegated work** views; use the conversation selector above it to return to your chat. Child conversations can be opened from their work cards. Researcher runs in the background and returns findings to Architect.

On the Android fork, use the Ticket button: the mobile tab selector only lists tabs already open, and the compact Explorer exposes Changes, Files and PR rather than plugin panels. The button works in the existing fork APK after the daemon plugin is reloaded.

Architect retains the current and previous operator exchange, including reasoning and tool traffic. Background workflow reports appear as workflow updates and do not consume those two operator slots. There is currently no token floor: normal Architect usage is being measured before choosing one. The [Paseo fork and its setup guide](https://github.com/hypermemetic-ai/paseo/blob/main/docs/architect-fork.md) makes the native conversation view follow that same selection; the stock app still shows its full archive. Put lasting decisions in the ticket rather than relying on older chat messages. If your project needs a particular test environment, describe it in an optional `.architect/scratch.md`; Architect will use that when planning tests.

## Updates and troubleshooting

After pulling an update and installing any changed dependencies, run:

```bash
npm run typecheck
paseo plugin reload architect
```

A plugin reload preserves pending work. If the background host needs an update, it waits for existing jobs to finish. You do not need to restart the Paseo daemon to load plugin changes.

If Architect does not appear or a request fails, check:

```bash
paseo plugin ls
paseo plugin logs architect
```

Confirm that you are connected to the intended daemon, that the plugin is running, and that the required tools and credentials are available on that machine. Work is preserved when a command or merge has an uncertain outcome; inspect the reported failure before starting replacement work.

## Development

Run checks from the repository root:

```bash
npm test
npm run test:python
npm run typecheck
```

`npm run test:live` additionally makes real Astra requests using your configured credentials.

- [Code guide](docs/architecture.md): entry points, agent runtimes and supporting modules.
- [Isolated setup guide](.architect/scratch.md): a separate Paseo home and disposable repositories for live tests.
- [Verification record](docs/verification.md): tested behavior and operational limitations.
- [Native Android testing](.architect/scratch.md#native-android-testing): emulator, APK identity and repeatable Ticket navigation checks.

For a daemon using Paseo's upcoming v0.8 plugin API, generate its runtime entries in a separate directory before installing:

```bash
node scripts/build-plugin-v08.mjs "${PASEO_HOME:-$HOME/.paseo}/plugins/architect-v08"
paseo plugin install "${PASEO_HOME:-$HOME/.paseo}/plugins/architect-v08" --id architect
```

The generated entries reuse this checkout's UI and host code. Keep the checkout available, and reload the plugin after updating it. Use a fresh output directory when regenerating the entries.

### Measure Architect usage

Run `node scripts/architect-usage.mjs --home "$HOME/.paseo-architect"` to report the selected daemon’s real Architect turns. Optional `--cwd /absolute/project/path` and `--source operator` or `--source wake` filters narrow the report. The report reads the local SQLite journal and makes no model calls.

It records user/reply text, tool calls/results, reported reasoning tokens, characters, provider attempts and peak request size. Completed two-turn windows are grouped within each session. Aborted, failed and unfinished turns remain visible but do not set the baseline; missing reasoning usage or tool outcomes are explicitly excluded. Pinned instructions, the ticket and tool definitions are outside the conversation measurement. Text counts use `o200k_base` as an estimate; encrypted reasoning is never measured as characters. Collection starts with labelled turns after this update, excluding historical test and coding-session data. No floor is selected automatically.

The proposed pressure-triggered replacement of reasoning/tool payloads with transcript pointers remains a separate change; this observation mode does not introduce automatic compaction.
