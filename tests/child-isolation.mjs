#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertChildSandbox,
  effectiveSandboxMode,
  isolatedCommand,
  isolatedShellCommand,
  pinChildSandbox,
} from "../src/child-isolation.mjs";
import { runCommand } from "../src/git.mjs";

const events = [];
const session = { id: "session-11111111-1111-4111-8111-111111111111", header: { cwd: process.cwd() }, events, append(type, data) { events.push({ type, data }); } };
assert.equal(pinChildSandbox(session, "implementation"), true);
assert.equal(pinChildSandbox(session, "implementation"), false);
assert.equal(effectiveSandboxMode(events), "workspace-write");

function sandboxAgent({
  enforcement = "full",
  mode = "workspace-write",
  services = true,
  strictProxy = true,
  workspaceRoot = process.cwd(),
} = {}) {
  const childSession = { ...session, events: [{ type: "sandbox/mode", data: { mode } }] };
  const serviceLookups = [];
  const rawCtx = {
    get(name, optional) {
      serviceLookups.push([name, optional]);
      if (!services) return null;
      if (name === "sandboxPolicy") return { resolve() { return { mode, workspaceRoot }; } };
      if (name === "shell") return { sandboxMode: "workspace-write" };
      if (name === "sandbox") return { confine() { return { enforcement }; } };
      return null;
    },
  };
  const ctx = strictProxy
    ? new Proxy(rawCtx, {
        get(target, prop, receiver) {
          if (prop in target || typeof prop === "symbol") return Reflect.get(target, prop, receiver);
          throw new Error(`cannot get property "${String(prop)}" without inject`);
        },
      })
    : rawCtx;
  return {
    session: childSession,
    ctx,
    serviceLookups,
  };
}
const strictAgent = sandboxAgent();
assert.throws(() => strictAgent.ctx.sandboxPolicy, /cannot get property "sandboxPolicy" without inject/);
assert.deepEqual(assertChildSandbox(strictAgent, "implementation"), { mode: "workspace-write", workspaceRoot: process.cwd() });
assert.deepEqual(strictAgent.serviceLookups, [
  ["sandboxPolicy", false],
  ["shell", false],
  ["sandbox", false],
], "strict Cordis contexts resolve every sandbox dependency through the sanctioned optional getter");
assert.throws(() => assertChildSandbox(sandboxAgent({ enforcement: "partial" }), "implementation"), /full DSH filesystem enforcement/);
assert.throws(() => assertChildSandbox(sandboxAgent({ services: false }), "implementation"), /requires the DSH sandbox-policy/);
assert.throws(() => assertChildSandbox(sandboxAgent({ mode: "read-only" }), "implementation"), /did not resolve workspace-write/);
assert.throws(() => assertChildSandbox(sandboxAgent({ workspaceRoot: tmpdir() }), "implementation"), /at its immutable cwd/);

const plainAgent = {
  session: { ...session, events: [{ type: "sandbox/mode", data: { mode: "workspace-write" } }] },
  ctx: {
    sandboxPolicy: { resolve() { return { mode: "workspace-write", workspaceRoot: process.cwd() }; } },
    shell: { sandboxMode: "workspace-write" },
    sandbox: { confine() { return { enforcement: "full" }; } },
  },
};
assert.deepEqual(assertChildSandbox(plainAgent, "implementation"), { mode: "workspace-write", workspaceRoot: process.cwd() });

const root = mkdtempSync(join(tmpdir(), "qq-child-boundary."));
const workspace = join(root, "workspace");
const gitDir = join(root, "capsule", ".git");
mkdirSync(workspace);
mkdirSync(gitDir, { recursive: true });
writeFileSync(join(gitDir, "sentinel"), "safe\n");
try {
  const implementation = isolatedCommand({
    workspace,
    gitDir,
    writable: true,
    command: "bash",
    args: ["-c", 'echo ordinary > ordinary.txt; echo forged > "$GIT_DIR/sentinel"'],
  });
  assert.ok(implementation.args.includes("--unshare-net"));
  assert.ok(implementation.args.includes("--clearenv"));
  const implementationResult = await runCommand(implementation.command, implementation.args, { cwd: workspace });
  assert.notEqual(implementationResult.code, 0, "authoritative metadata write is denied");
  assert.equal(readFileSync(join(workspace, "ordinary.txt"), "utf8"), "ordinary\n", "ordinary workspace write succeeds");
  assert.equal(readFileSync(join(gitDir, "sentinel"), "utf8"), "safe\n", "host Git metadata remains unchanged");

  const qa = isolatedCommand({
    workspace,
    gitDir,
    writable: false,
    command: "bash",
    args: ["-c", "echo qa > qa.txt"],
  });
  const qaResult = await runCommand(qa.command, qa.args, { cwd: workspace });
  assert.notEqual(qaResult.code, 0, "QA workspace is read-only");
  assert.equal(existsSync(join(workspace, "qa.txt")), false);

  const network = isolatedCommand({
    workspace,
    command: "bash",
    args: ["-c", "test ! -s /proc/net/route"],
  });
  assert.equal((await runCommand(network.command, network.args, { cwd: workspace })).code, 0, "child has no routed network interface");

  // Implementation commands are nested inside the fully enforcing host
  // sandbox. Preserve that outer mount graph so host-authorized project roots
  // remain writable without ever passing raw model path strings to bwrap.
  const home = join(root, "home");
  const cargo = join(home, ".cargo");
  const ssh = join(home, ".ssh");
  const buildCache = join(root, "build-cache");
  mkdirSync(cargo, { recursive: true });
  mkdirSync(ssh, { recursive: true });
  mkdirSync(buildCache);
  assert.throws(() => isolatedCommand({
    workspace,
    command: "true",
    writable: false,
    preserveOuterWritePolicy: true,
  }), /requires a writable child workspace/);
  const inherited = isolatedCommand({
    workspace,
    gitDir,
    command: "bash",
    args: [
      "-c",
      [
        "printf 'workspace\n' > inherited.txt",
        "printf 'cargo\n' > \"$HOME/.cargo/cache\"",
        "printf 'build\n' > \"$1/cache\"",
        "if (printf 'denied\n' > \"$HOME/.ssh/nope\") 2>/dev/null; then exit 41; fi",
        "if (printf 'forged\n' > \"$GIT_DIR/sentinel\") 2>/dev/null; then exit 42; fi",
      ].join("; "),
      "bash",
      buildCache,
    ],
    writable: true,
    preserveOuterWritePolicy: true,
    env: { ...process.env, HOME: home },
  });
  assert.deepEqual(inherited.args.slice(5, 8), ["--bind", "/", "/"], "inner root preserves the outer write policy");
  assert.equal(inherited.args.includes("--tmpfs"), false, "inner overlays cannot hide an authorized root");
  const gitBind = inherited.args.findIndex((value, index) => value === "--ro-bind"
    && inherited.args[index + 1] === gitDir && inherited.args[index + 2] === gitDir);
  assert.notEqual(gitBind, -1, "authoritative Git metadata is explicitly read-only in the inherited view");
  const homeEnv = inherited.args.findIndex((value, index) => value === "--setenv"
    && inherited.args[index + 1] === "HOME");
  assert.equal(inherited.args[homeEnv + 2], home, "tilde expansion still addresses the host-authorized home child");

  // This outer profile stands in for host validation: it grants exactly cargo
  // and buildCache in addition to the workspace, but not the sibling ssh root.
  const outer = [
    "--die-with-parent",
    "--new-session",
    "--ro-bind", "/", "/",
    "--bind", workspace, workspace,
    "--bind", cargo, cargo,
    "--bind", buildCache, buildCache,
    "--dev", "/dev",
    "--proc", "/proc",
    "--",
    inherited.command,
    ...inherited.args,
  ];
  const inheritedResult = await runCommand("/usr/bin/bwrap", outer, { cwd: workspace });
  assert.equal(inheritedResult.code, 0, inheritedResult.stderr);
  assert.equal(readFileSync(join(workspace, "inherited.txt"), "utf8"), "workspace\n");
  assert.equal(readFileSync(join(cargo, "cache"), "utf8"), "cargo\n", "authorized ~/.cargo survives inner isolation");
  assert.equal(readFileSync(join(buildCache, "cache"), "utf8"), "build\n", "a second authorized root survives inner isolation");
  assert.equal(existsSync(join(ssh, "nope")), false, "an unapproved sibling stays read-only");
  assert.equal(readFileSync(join(gitDir, "sentinel"), "utf8"), "safe\n", "metadata stays read-only");

  const wrapped = isolatedShellCommand({ workspace, worktree: join(root, "capsule"), command: "printf '%s' tricky", writable: true });
  assert.match(wrapped, /--unshare-net/);
  assert.match(wrapped, /--clearenv/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("child isolation: ok");
