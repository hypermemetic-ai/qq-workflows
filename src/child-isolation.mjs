import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const IMPLEMENTATION_SANDBOX_MODE = "workspace-write";
export const QA_SANDBOX_MODE = "read-only";

export function effectiveSandboxMode(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "sandbox/mode") return event.data?.mode;
  }
  return undefined;
}

export function pinChildSandbox(agentOrSession, role) {
  const session = agentOrSession?.session ?? agentOrSession;
  if (!session || typeof session.append !== "function") {
    throw new Error("delegated sandbox requires a writable session");
  }
  const mode = role === "qa" ? QA_SANDBOX_MODE : IMPLEMENTATION_SANDBOX_MODE;
  if (effectiveSandboxMode(session.events) === mode) return false;
  session.append("sandbox/mode", { mode, source: "delegation" });
  return true;
}

function serviceOf(ctx, name) {
  return ctx?.[name] ?? ctx?.get?.(name, false) ?? null;
}

/** Require DSH's kernel-backed file boundary for the child session root. */
export function assertChildSandbox(agent, role) {
  const session = agent?.session;
  const cwd = session?.header?.cwd;
  const mode = role === "qa" ? QA_SANDBOX_MODE : IMPLEMENTATION_SANDBOX_MODE;
  if (!session || !cwd) throw new Error("delegated sandbox requires a session cwd");
  const policy = serviceOf(agent?.ctx, "sandboxPolicy");
  const shell = serviceOf(agent?.ctx, "shell");
  const sandbox = serviceOf(agent?.ctx, "sandbox");
  if (!policy || typeof policy.resolve !== "function" || !shell || shell.sandboxMode === undefined
    || !sandbox || typeof sandbox.confine !== "function") {
    throw new Error("delegated child requires the DSH sandbox-policy, sandboxed shell, and sandbox provider");
  }
  const resolved = policy.resolve({ session });
  const root = realpathSync(cwd);
  let resolvedRoot = "";
  try { resolvedRoot = realpathSync(resolved?.workspaceRoot ?? ""); } catch {}
  if (resolved?.mode !== mode || resolvedRoot !== root) {
    throw new Error(`delegated child sandbox did not resolve ${mode} at its immutable cwd`);
  }
  const confined = sandbox.confine(["true"], {
    mode,
    workspaceRoot: root,
    sessionId: session.id,
  });
  if (confined?.enforcement !== "full") {
    throw new Error("delegated child requires full DSH filesystem enforcement");
  }
  return Object.freeze({ mode, workspaceRoot: root });
}

function cleanPath(env = process.env) {
  return String(env?.PATH || "/usr/local/bin:/usr/bin:/bin");
}

/**
 * One command inside a metadata-read-only, credential-empty, no-network
 * namespace. The caller invokes bwrap directly; no model command is parsed.
 */
export function isolatedCommand({ workspace, gitDir, command, args = [], writable = true, env = process.env } = {}) {
  if (!workspace || !command) throw new Error("isolated command requires workspace and command");
  const bwrap = String(env?.QQ_WORKFLOWS_BWRAP || "/usr/bin/bwrap");
  const bind = writable ? "--bind" : "--ro-bind";
  const privateHome = join(workspace, ".qq-workflows-home");
  mkdirSync(privateHome, { recursive: true });
  const tmpParents = [];
  if (workspace.startsWith("/tmp/")) {
    const parts = workspace.split("/").filter(Boolean);
    let current = "";
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      if (current !== "/tmp") tmpParents.push("--dir", current);
    }
  }
  const argv = [
    "--die-with-parent",
    "--new-session",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-pid",
    "--ro-bind", "/", "/",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run/user",
    ...tmpParents,
    bind, workspace, workspace,
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", privateHome,
    "--chdir", workspace,
    "--clearenv",
    "--setenv", "PATH", cleanPath(env),
    "--setenv", "HOME", privateHome,
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--setenv", "NO_COLOR", "1",
    "--setenv", "PAGER", "cat",
    "--setenv", "GIT_PAGER", "cat",
    "--setenv", "GIT_CONFIG_NOSYSTEM", "1",
    "--setenv", "GIT_CONFIG_GLOBAL", "/dev/null",
    "--setenv", "GIT_TERMINAL_PROMPT", "0",
    "--setenv", "GIT_OPTIONAL_LOCKS", "0",
    ...(gitDir ? [
      "--setenv", "GIT_DIR", gitDir,
      "--setenv", "GIT_WORK_TREE", workspace,
    ] : []),
    "--",
    String(command),
    ...args.map(String),
  ];
  return Object.freeze({ command: bwrap, args: Object.freeze(argv) });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function isolatedShellCommand(options = {}) {
  const gitDir = options.gitDir || join(options.worktree, ".git");
  const isolated = isolatedCommand({
    ...options,
    gitDir,
    command: "bash",
    args: ["-c", String(options.command ?? "")],
  });
  return [isolated.command, ...isolated.args].map(shellQuote).join(" ");
}
