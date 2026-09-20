import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_STATE_SUBDIR = "qq-workflows/operator-actions";
export const VALID_ACTION_TYPES = new Set(["secret_entry", "approval", "command"]);

export function resolveActionBaseDir(customBaseDir, env = process.env) {
  if (customBaseDir) return resolve(customBaseDir);
  if (env.QQ_OPERATOR_ACTION_DIR) return resolve(env.QQ_OPERATOR_ACTION_DIR);
  if (env.XDG_STATE_HOME) return join(resolve(env.XDG_STATE_HOME), DEFAULT_STATE_SUBDIR);
  return join(homedir(), ".local", "state", DEFAULT_STATE_SUBDIR);
}

export function resolveActionTmpDir(customTmpDir) {
  if (customTmpDir) return resolve(customTmpDir);
  return tmpdir();
}

export function generateActionIdentity() {
  const uuid = randomUUID();
  const shortId = uuid.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  const actionId = `act-${shortId}-${uuid.slice(0, 8)}`;
  return { actionId, shortId };
}

export function formatPromptBlock(targetMachine, shortInvocation) {
  return `Run on ${targetMachine}:\n\`\`\`bash\n${shortInvocation}\n\`\`\``;
}

export function getChildPids(pid) {
  try {
    const content = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    return content.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

export function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!pid) return;
  const children = getChildPids(pid);
  for (const cpid of children) {
    terminateProcessTree(cpid, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {}
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Stage an isolated operator action with private unique storage,
 * short single-line invocation (<40 chars), and truthful lifecycle tracking.
 */
export async function stageOperatorAction({
  title,
  explanation,
  actionType = "command",
  targetMachine,
  scriptPath,
  scriptContent,
  commandSpec,
  baseDir: customBaseDir,
  tmpDir: customTmpDir,
} = {}) {
  if (!title || typeof title !== "string" || !title.trim()) {
    throw new Error("title must be a non-empty string");
  }
  if (!explanation || typeof explanation !== "string" || !explanation.trim()) {
    throw new Error("explanation must be a non-empty string");
  }
  if (!targetMachine || typeof targetMachine !== "string" || !targetMachine.trim()) {
    throw new Error("targetMachine must be explicitly specified (e.g. 'qq-box' or 'infer1')");
  }

  const effectiveActionType = String(actionType || "command").trim();
  if (!VALID_ACTION_TYPES.has(effectiveActionType)) {
    throw new Error(`Invalid actionType '${effectiveActionType}': expected one of ${Array.from(VALID_ACTION_TYPES).join(", ")}`);
  }

  // Handle commandSpec if provided
  let effectiveScriptPath = scriptPath;
  if (!effectiveScriptPath && commandSpec?.scriptPath) {
    effectiveScriptPath = commandSpec.scriptPath;
  }

  if (!effectiveScriptPath && (scriptContent === undefined || scriptContent === null)) {
    throw new Error("Either scriptPath or scriptContent must be provided");
  }

  if (effectiveScriptPath) {
    if (!isAbsolute(effectiveScriptPath)) {
      throw new Error(`scriptPath must be an absolute path: ${effectiveScriptPath}`);
    }
    if (!existsSync(effectiveScriptPath)) {
      throw new Error(`scriptPath does not exist: ${effectiveScriptPath}`);
    }
    const st = await stat(effectiveScriptPath);
    if (!st.isFile()) {
      throw new Error(`scriptPath is not a regular file: ${effectiveScriptPath}`);
    }
  }

  const baseDir = resolveActionBaseDir(customBaseDir);
  const tmpDir = resolveActionTmpDir(customTmpDir);
  await mkdir(tmpDir, { recursive: true });

  // Allocate unique shortId and trampoline in tmpDir using open with "wx" (O_CREAT | O_EXCL)
  // This guarantees:
  // 1. Atomic creation without race conditions.
  // 2. Collision detection (retries on EEXIST).
  // 3. Symlink safety (O_CREAT | O_EXCL rejects symlinks, preventing symlink overwrite attacks).
  // 4. Secure mode 0700 permissions from creation.
  let actionId = "";
  let shortId = "";
  let shortPath = "";
  let shortInvocation = "";
  let trampolineHandle = null;

  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ident = generateActionIdentity();
    const candidatePath = join(tmpDir, `qqa-${ident.shortId}`);
    try {
      trampolineHandle = await open(candidatePath, "wx", 0o700);
      actionId = ident.actionId;
      shortId = ident.shortId;
      shortPath = candidatePath;
      shortInvocation = `bash ${shortPath}`;
      break;
    } catch (err) {
      if (err?.code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }

  if (!trampolineHandle) {
    throw new Error(`Failed to allocate unique trampoline path in ${tmpDir} after ${maxAttempts} attempts`);
  }

  const actionDir = join(baseDir, actionId);

  // 1. Create action directory with mode 0700
  await mkdir(actionDir, { recursive: true, mode: 0o700 });
  await chmod(actionDir, 0o700);

  // 2. Prepare payload script
  let targetExecutable = "";
  if (scriptContent !== undefined && scriptContent !== null) {
    const payloadPath = join(actionDir, "payload.sh");
    await writeFile(payloadPath, String(scriptContent), { encoding: "utf8", mode: 0o700 });
    await chmod(payloadPath, 0o700);
    targetExecutable = payloadPath;
  } else {
    targetExecutable = effectiveScriptPath;
  }

  // 3. Write update-state.mjs helper inside actionDir
  const updateStateHelperPath = join(actionDir, "update-state.mjs");
  const updateStateHelperCode = `import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const statePath = resolve(process.argv[2]);
const targetStatus = process.argv[3];
const exitCodeRaw = process.argv[4];
const errorMsgRaw = process.argv[5];

try {
  const content = readFileSync(statePath, "utf8");
  const data = JSON.parse(content);
  const now = new Date().toISOString();

  if (targetStatus === "running") {
    if (data.status === "cancelled" || data.status === "cancellation_requested") {
      process.exit(1);
    }
    if (data.status === "succeeded") {
      process.exit(1);
    }
    if (data.status === "running" && data.pid) {
      try {
        process.kill(data.pid, 0);
        process.stderr.write("Action already running with PID " + data.pid + "\\n");
        process.exit(2);
      } catch {}
    }
    data.status = "running";
    if (exitCodeRaw && exitCodeRaw !== "null") {
      data.pid = parseInt(exitCodeRaw, 10);
    }
    if (!data.startedAt) data.startedAt = now;
  } else if (targetStatus === "succeeded") {
    // If cancellation was requested or cancelled, preserve cancelled status (no resurrection!)
    if (data.status === "cancelled" || data.status === "cancellation_requested") {
      data.status = "cancelled";
      data.completedAt = now;
      data.verified = false;
      data.exitCode = 130;
      data.error = data.error || "Action was cancelled during execution";
    } else {
      data.status = "succeeded";
      data.completedAt = now;
      data.verified = true;
      data.exitCode = 0;
      data.error = null;
    }
  } else if (targetStatus === "failed") {
    if (data.status === "cancelled" || data.status === "cancellation_requested") {
      data.status = "cancelled";
      data.completedAt = now;
      data.verified = false;
      data.exitCode = exitCodeRaw && exitCodeRaw !== "null" ? parseInt(exitCodeRaw, 10) : 130;
      data.error = data.error || "Action was cancelled during execution";
    } else {
      data.status = "failed";
      data.completedAt = now;
      data.verified = false;
      data.exitCode = exitCodeRaw && exitCodeRaw !== "null" ? parseInt(exitCodeRaw, 10) : 1;
      data.error = errorMsgRaw && errorMsgRaw !== "null" ? errorMsgRaw : ("Exited with code " + data.exitCode);
    }
  } else if (targetStatus === "cancelled") {
    data.status = "cancelled";
    data.completedAt = now;
    data.verified = false;
    data.exitCode = exitCodeRaw && exitCodeRaw !== "null" ? parseInt(exitCodeRaw, 10) : 130;
    data.error = errorMsgRaw && errorMsgRaw !== "null" ? errorMsgRaw : "Operator interrupted";
  }

  writeFileSync(statePath, JSON.stringify(data, null, 2) + "\\n", { mode: 0o600 });
} catch (e) {
  process.stderr.write("Failed to update state: " + (e?.message || String(e)) + "\\n");
  process.exit(1);
}
`;
  await writeFile(updateStateHelperPath, updateStateHelperCode, { encoding: "utf8", mode: 0o700 });
  await chmod(updateStateHelperPath, 0o700);

  // 4. Initial state.json
  const statePath = join(actionDir, "state.json");
  const initialState = {
    actionId,
    shortId,
    targetMachine: targetMachine.trim(),
    actionType: effectiveActionType,
    title: title.trim(),
    explanation: explanation.trim(),
    status: "pending",
    verified: false,
    stagedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    exitCode: null,
    error: null,
    pid: null,
    shortInvocation,
    shortPath,
    actionDir,
    tmpDir,
    targetExecutable,
  };
  await writeFile(statePath, JSON.stringify(initialState, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(statePath, 0o600);

  // 5. Write runner.sh
  const runnerPath = join(actionDir, "runner.sh");
  const runnerScript = `#!/usr/bin/env bash
set -u

ACTION_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="\${ACTION_DIR}/state.json"
UPDATE_HELPER="\${ACTION_DIR}/update-state.mjs"
TARGET_EXEC="${targetExecutable}"
NODE_BIN="\${QQ_NODE_BIN:-$(command -v node 2>/dev/null || echo node)}"

# Check if already completed, cancelled, or running
CHECK_RESULT=$("$NODE_BIN" -e '
try {
  const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (s.status === "cancelled" || s.status === "cancellation_requested") {
    console.log("cancelled");
  } else if (s.status === "succeeded") {
    console.log("succeeded");
  } else if (s.status === "running" && s.pid) {
    try {
      process.kill(s.pid, 0);
      console.log("running_alive:" + s.pid);
    } catch {
      console.log("running_dead");
    }
  } else {
    console.log(s.status);
  }
} catch {
  console.log("unknown");
}
' "$STATE_FILE" 2>/dev/null || echo "unknown")

if [ "$CHECK_RESULT" = "cancelled" ]; then
  printf 'Action %s was cancelled.\\n' "${actionId}" >&2
  exit 1
elif [ "$CHECK_RESULT" = "succeeded" ]; then
  printf 'Action %s has already succeeded.\\n' "${actionId}" >&2
  exit 0
elif [[ "$CHECK_RESULT" == running_alive:* ]]; then
  printf 'Action %s is already running (%s).\\n' "${actionId}" "$CHECK_RESULT" >&2
  exit 1
fi

# Transition to running with runner PID ($$)
"$NODE_BIN" "$UPDATE_HELPER" "$STATE_FILE" "running" "$$" "null"
transition_ec=$?
if [ "$transition_ec" -ne 0 ]; then
  printf 'Action %s failed to transition to running (code %d).\\n' "${actionId}" "$transition_ec" >&2
  exit 1
fi

cancelled=0
on_interrupt() {
  cancelled=1
  "$NODE_BIN" "$UPDATE_HELPER" "$STATE_FILE" "cancelled" "130" "Interrupted by signal"
  printf '\\n[operator-action] Action cancelled.\\n' >&2
  exit 130
}
trap on_interrupt INT TERM

# Run target executable preserving tty / stdin
if [ -x "$TARGET_EXEC" ]; then
  "$TARGET_EXEC" "$@"
  ec=$?
else
  bash "$TARGET_EXEC" "$@"
  ec=$?
fi

if [ "$ec" -eq 0 ]; then
  "$NODE_BIN" "$UPDATE_HELPER" "$STATE_FILE" "succeeded" "0" "null"
  printf '\\n[operator-action] Action succeeded.\\n'
  exit 0
elif [ "$ec" -eq 130 ]; then
  "$NODE_BIN" "$UPDATE_HELPER" "$STATE_FILE" "cancelled" "130" "Interrupted by operator"
  printf '\\n[operator-action] Action cancelled.\\n' >&2
  exit 130
else
  "$NODE_BIN" "$UPDATE_HELPER" "$STATE_FILE" "failed" "$ec" "Process exited with code $ec"
  printf '\\n[operator-action] Action failed (exit code %d).\\n' "$ec" >&2
  exit "$ec"
fi
`;
  await writeFile(runnerPath, runnerScript, { encoding: "utf8", mode: 0o700 });
  await chmod(runnerPath, 0o700);

  // 6. Write trampoline script via open handle and close
  const trampolineScript = `#!/usr/bin/env bash
exec "${runnerPath}" "$@"
`;
  await trampolineHandle.writeFile(trampolineScript, "utf8");
  await trampolineHandle.close();

  const promptBlock = formatPromptBlock(targetMachine.trim(), shortInvocation);

  return {
    actionId,
    shortId,
    targetMachine: targetMachine.trim(),
    actionType: effectiveActionType,
    status: "pending",
    shortInvocation,
    shortPath,
    promptBlock,
    actionDir,
    stateFile: statePath,
    runnerScript: runnerPath,
    targetExecutable,
    note: `Staged locally. Operator must execute on ${targetMachine.trim()}.`,
  };
}

/**
 * Check the status of a staged operator action.
 */
export async function checkOperatorAction({
  actionId,
  baseDir: customBaseDir,
} = {}) {
  if (!actionId || typeof actionId !== "string" || !actionId.trim()) {
    throw new Error("actionId must be a non-empty string");
  }

  const baseDir = resolveActionBaseDir(customBaseDir);
  const statePath = join(baseDir, actionId.trim(), "state.json");

  if (!existsSync(statePath)) {
    throw new Error(`Operator action '${actionId}' not found at ${statePath}`);
  }

  const content = await readFile(statePath, "utf8");
  const data = JSON.parse(content);

  // If status is cancellation_requested, check if process has now terminated
  if (data.status === "cancellation_requested") {
    const alive = isPidAlive(data.pid);
    if (!alive) {
      data.status = "cancelled";
      data.completedAt = new Date().toISOString();
      data.verified = false;
      data.exitCode = data.exitCode ?? 130;
      data.error = data.error || "Action cancelled";
      try {
        await writeFile(statePath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      } catch {
        /* best effort */
      }
    }
  }

  return {
    actionId: data.actionId,
    status: data.status,
    targetMachine: data.targetMachine,
    actionType: data.actionType,
    title: data.title,
    explanation: data.explanation,
    verified: Boolean(data.verified),
    exitCode: data.exitCode ?? null,
    error: data.error ?? null,
    stagedAt: data.stagedAt,
    startedAt: data.startedAt ?? null,
    completedAt: data.completedAt ?? null,
    shortInvocation: data.shortInvocation,
  };
}

/**
 * Cancel a pending or running staged operator action.
 */
export async function cancelOperatorAction({
  actionId,
  reason,
  baseDir: customBaseDir,
} = {}) {
  if (!actionId || typeof actionId !== "string" || !actionId.trim()) {
    throw new Error("actionId must be a non-empty string");
  }

  const baseDir = resolveActionBaseDir(customBaseDir);
  const statePath = join(baseDir, actionId.trim(), "state.json");

  if (!existsSync(statePath)) {
    throw new Error(`Operator action '${actionId}' not found`);
  }

  const content = await readFile(statePath, "utf8");
  const data = JSON.parse(content);

  // Terminal states cannot be cancelled
  if (data.status === "succeeded") {
    return {
      actionId: data.actionId,
      status: "succeeded",
      cancelled: false,
      message: "Action has already succeeded and cannot be cancelled",
    };
  }
  if (data.status === "failed") {
    return {
      actionId: data.actionId,
      status: "failed",
      cancelled: false,
      message: "Action has already failed and cannot be cancelled",
    };
  }
  if (data.status === "cancelled") {
    return {
      actionId: data.actionId,
      status: "cancelled",
      cancelled: true,
      message: "Action is already cancelled",
    };
  }

  const now = new Date().toISOString();
  const cancelReason = reason || "Cancelled by caller";

  if (data.status === "pending") {
    data.status = "cancelled";
    data.completedAt = now;
    data.verified = false;
    data.exitCode = 130;
    data.error = cancelReason;
    await writeFile(statePath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    return {
      actionId: data.actionId,
      status: "cancelled",
      cancelled: true,
      completedAt: now,
      error: data.error,
    };
  }

  // If running or cancellation_requested:
  let alive = isPidAlive(data.pid);
  if (alive) {
    terminateProcessTree(data.pid, "SIGTERM");
    alive = isPidAlive(data.pid);
  }

  if (alive) {
    // Process is still executing writes! Truthfully report cancellation_requested
    data.status = "cancellation_requested";
    data.cancellationRequestedAt = now;
    data.error = cancelReason;
    await writeFile(statePath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    return {
      actionId: data.actionId,
      status: "cancellation_requested",
      cancelled: false,
      cancellationRequestedAt: now,
      error: data.error,
    };
  }

  data.status = "cancelled";
  data.completedAt = now;
  data.verified = false;
  data.exitCode = data.exitCode ?? 130;
  data.error = cancelReason;
  await writeFile(statePath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return {
    actionId: data.actionId,
    status: "cancelled",
    cancelled: true,
    completedAt: now,
    error: data.error,
  };
}

/**
 * Clean up staged action files.
 * Safely removes only the staged actionDir and the specific shortPath in tmp.
 * Never touches real credentials or external files.
 */
export async function cleanupOperatorAction({
  actionId,
  force = false,
  baseDir: customBaseDir,
  tmpDir: customTmpDir,
} = {}) {
  if (!actionId || typeof actionId !== "string" || !actionId.trim()) {
    throw new Error("actionId must be a non-empty string");
  }

  const trimmedId = actionId.trim();
  if (!/^act-[a-zA-Z0-9]+-[a-zA-Z0-9]+$/.test(trimmedId)) {
    throw new Error(`Invalid actionId format: ${actionId}`);
  }

  const baseDir = resolveActionBaseDir(customBaseDir);
  const actionDir = join(baseDir, trimmedId);
  const statePath = join(actionDir, "state.json");

  if (!existsSync(actionDir)) {
    return { actionId: trimmedId, cleaned: true, note: "Action directory does not exist" };
  }

  let shortPath = null;
  let currentStatus = null;
  let pid = null;
  let recordedTmpDir = null;
  if (existsSync(statePath)) {
    try {
      const data = JSON.parse(await readFile(statePath, "utf8"));
      shortPath = data.shortPath;
      currentStatus = data.status;
      pid = data.pid ?? null;
      recordedTmpDir = data.tmpDir ?? null;
    } catch {
      /* ignore corrupted state during cleanup */
    }
  }

  const isAlive = pid ? isPidAlive(pid) : false;
  const isActive = isAlive || currentStatus === "pending" || currentStatus === "running" || currentStatus === "cancellation_requested";
  if (!force && isActive) {
    throw new Error(`Cannot cleanup active action in '${currentStatus || "running"}' state. Cancel it first or pass force: true.`);
  }

  // If force: true and process is still running, terminate the process tree to prevent ghost process resurrection
  if (isAlive) {
    terminateProcessTree(pid, "SIGTERM");
  }

  // Safely remove the short trampoline script in tmpDir
  // Strictly verify: must be directly inside tmpDir and match qqa-*
  const expectedTmpDir = resolve(customTmpDir || recordedTmpDir || tmpdir());
  if (shortPath && typeof shortPath === "string") {
    const resolvedShort = resolve(shortPath);
    if (dirname(resolvedShort) === expectedTmpDir && basename(resolvedShort).startsWith("qqa-")) {
      try {
        const lst = await lstat(resolvedShort);
        if (lst.isSymbolicLink()) {
          // Unlink symlink directly without following
          await unlink(resolvedShort);
        } else if (lst.isFile()) {
          await rm(resolvedShort, { force: true });
        }
      } catch (err) {
        if (err?.code !== "ENOENT") {
          /* best effort */
        }
      }
    }
  }

  // Remove the action directory
  await rm(actionDir, { recursive: true, force: true });

  return {
    actionId: trimmedId,
    cleaned: true,
  };
}

export const OPERATOR_ACTION_TOOLS = [
  {
    name: "stage_operator_action",
    description: "Stage an isolated operator action with a short single-line invocation (<40 chars), private unique storage, explicit target machine label, and truthful lifecycle tracking without exposing secrets to agents. Staging occurs locally; targetMachine indicates the intended host for operator execution.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short human-readable action title",
        },
        explanation: {
          type: "string",
          description: "Explanation of why the action is needed and what target it affects",
        },
        actionType: {
          type: "string",
          enum: ["secret_entry", "approval", "command"],
          description: "Category of operator action (default: command)",
        },
        targetMachine: {
          type: "string",
          enum: ["qq-box", "infer1"],
          description: "Explicit target machine label where operator should execute the action ('qq-box' or 'infer1'). Note: does not execute remote commands automatically.",
        },
        scriptPath: {
          type: "string",
          description: "Absolute path of existing prepared executable script on target machine",
        },
        scriptContent: {
          type: "string",
          description: "Shell script content to stage as the action payload",
        },
        commandSpec: {
          type: "object",
          properties: {
            scriptPath: { type: "string" },
            shortInvocation: { type: "string" },
          },
          description: "Optional legacy commandSpec containing scriptPath",
        },
      },
      required: ["title", "explanation", "targetMachine"],
    },
  },
  {
    name: "check_operator_action",
    description: "Check truthful lifecycle status of a staged operator action (pending, running, cancellation_requested, succeeded, failed, or cancelled). Command exit code 0 indicates command success.",
    inputSchema: {
      type: "object",
      properties: {
        actionId: {
          type: "string",
          description: "Unique identifier of the staged action",
        },
      },
      required: ["actionId"],
    },
  },
  {
    name: "cancel_operator_action",
    description: "Cancel a pending or running staged operator action. Signals running process and records truthful cancellation state.",
    inputSchema: {
      type: "object",
      properties: {
        actionId: {
          type: "string",
          description: "Unique identifier of the staged action to cancel",
        },
        reason: {
          type: "string",
          description: "Optional cancellation reason",
        },
      },
      required: ["actionId"],
    },
  },
  {
    name: "cleanup_operator_action",
    description: "Clean up staged runner and invocation files for a completed or cancelled operator action. Requires force to clean active actions.",
    inputSchema: {
      type: "object",
      properties: {
        actionId: {
          type: "string",
          description: "Unique identifier of the staged action to clean up",
        },
        force: {
          type: "boolean",
          description: "Force cleanup even if the action has not reached a terminal state",
        },
      },
      required: ["actionId"],
    },
  },
];
