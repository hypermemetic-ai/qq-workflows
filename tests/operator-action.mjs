import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelOperatorAction,
  checkOperatorAction,
  cleanupOperatorAction,
  formatPromptBlock,
  resolveActionBaseDir,
  stageOperatorAction,
} from "../workflow/operator-action.mjs";

console.log("Running operator-action tests...");

const tempRoot = await mkdtemp(join(tmpdir(), "op-action-test-"));
const baseDir = join(tempRoot, "state");
const tmpDir = join(tempRoot, "tmp");

try {
  // Test 1: Target machine must be explicitly specified
  {
    await assert.rejects(
      stageOperatorAction({
        title: "Test Action",
        explanation: "No machine specified",
        scriptContent: "echo hi",
      }),
      /targetMachine must be explicitly specified/,
      "Must throw when targetMachine is omitted"
    );

    await assert.rejects(
      stageOperatorAction({
        title: "Test Action",
        explanation: "Empty machine",
        targetMachine: "   ",
        scriptContent: "echo hi",
      }),
      /targetMachine must be explicitly specified/,
      "Must throw when targetMachine is empty"
    );
  }

  // Test 2: Validation of title, explanation, and script source
  {
    await assert.rejects(
      stageOperatorAction({
        targetMachine: "qq-box",
        explanation: "Missing title",
        scriptContent: "echo hi",
      }),
      /title must be a non-empty string/
    );

    await assert.rejects(
      stageOperatorAction({
        targetMachine: "qq-box",
        title: "Missing explanation",
        scriptContent: "echo hi",
      }),
      /explanation must be a non-empty string/
    );

    await assert.rejects(
      stageOperatorAction({
        targetMachine: "qq-box",
        title: "Missing script",
        explanation: "Neither content nor path",
      }),
      /Either scriptPath or scriptContent must be provided/
    );

    await assert.rejects(
      stageOperatorAction({
        targetMachine: "qq-box",
        title: "Invalid path",
        explanation: "Nonexistent script",
        scriptPath: "/tmp/this-script-does-not-exist-xyz-123",
      }),
      /scriptPath does not exist/
    );
  }

  // Test 3: Short invocation length and formatting invariants
  {
    const staged = await stageOperatorAction({
      title: "Key Setup",
      explanation: "Configure credentials",
      actionType: "secret_entry",
      targetMachine: "qq-box",
      scriptContent: "#!/bin/bash\necho ok",
      baseDir,
    });

    assert.ok(staged.shortInvocation.startsWith("bash "), "Short invocation must start with 'bash '");
    assert.ok(
      staged.shortInvocation.length < 40,
      `Short invocation must be under 40 chars: was ${staged.shortInvocation.length} ('${staged.shortInvocation}')`
    );

    const prompt = staged.promptBlock;
    assert.match(prompt, /^Run on qq-box:\n```bash\nbash [^\n]+\n```$/m, "Prompt must be unindented code block");

    // Check directory permissions (0700) and state file permissions (0600)
    const dirStat = statSync(staged.actionDir);
    assert.equal(dirStat.mode & 0o777, 0o700, "Action directory must have mode 0700");

    const stateStat = statSync(staged.stateFile);
    assert.equal(stateStat.mode & 0o777, 0o600, "State file must have mode 0600");

    // Clean up
    await cleanupOperatorAction({ actionId: staged.actionId, force: true, baseDir });
  }

  // Test 4: Lifecycle - Succeeded flow with simulated hidden credential entry
  {
    const credStore = join(tempRoot, "mock-credentials");
    // Synthetic script mimicking /tmp/jev-key: reads input silently and writes to mode 0600
    const syntheticScript = `#!/usr/bin/env bash
set -e
umask 077
read -r -s input_val
if [ -z "$input_val" ]; then
  echo "Empty secret" >&2
  exit 1
fi
printf '%s\\n' "$input_val" > "${credStore}"
chmod 600 "${credStore}"
printf 'Configured\\n'
`;

    const staged = await stageOperatorAction({
      title: "Diagnostic Credential Setup",
      explanation: "Safe secret staging",
      actionType: "secret_entry",
      targetMachine: "qq-box",
      scriptContent: syntheticScript,
      baseDir,
      tmpDir,
    });

    // Initial check: pending
    const initialCheck = await checkOperatorAction({ actionId: staged.actionId, baseDir });
    assert.equal(initialCheck.status, "pending");
    assert.equal(initialCheck.verified, false);
    assert.equal(initialCheck.completedAt, null);

    // Run the short invocation, passing secret via stdin
    const secretValue = "super-secret-test-token-xyz-12345";
    const result = spawnSync("bash", [staged.shortPath], {
      input: secretValue + "\n",
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `Execution failed with output: ${result.stderr}`);
    assert.ok(result.stdout.includes("Configured"), "Script output should confirm configuration");
    assert.ok(result.stdout.includes("[operator-action] Action succeeded."), "Runner should report success");

    // Verify disk result
    assert.ok(existsSync(credStore), "Mock credential store should exist");
    assert.equal(readFileSync(credStore, "utf8").trim(), secretValue, "Mock credential store contains secret");
    const credStat = statSync(credStore);
    assert.equal(credStat.mode & 0o777, 0o600, "Mock credential store mode must be 0600");

    // Check status via checkOperatorAction
    const afterCheck = await checkOperatorAction({ actionId: staged.actionId, baseDir });
    assert.equal(afterCheck.status, "succeeded");
    assert.equal(afterCheck.verified, true);
    assert.equal(afterCheck.exitCode, 0);
    assert.ok(afterCheck.completedAt !== null, "completedAt must be set");

    // CRUCIAL: Secret must NEVER be present in state.json or check response
    const stateRaw = readFileSync(staged.stateFile, "utf8");
    assert.ok(!stateRaw.includes(secretValue), "state.json must NEVER contain the secret!");
    assert.ok(!JSON.stringify(afterCheck).includes(secretValue), "checkOperatorAction must NEVER expose the secret!");

    // Clean up
    await cleanupOperatorAction({ actionId: staged.actionId, baseDir });
    assert.ok(!existsSync(staged.actionDir), "Action directory should be removed by cleanup");
    assert.ok(!existsSync(staged.shortPath), "Short invocation trampoline should be removed by cleanup");
    assert.ok(existsSync(credStore), "Cleanup must NOT touch destination credential files!");
  }

  // Test 5: Lifecycle - Failed flow (e.g. invalid input / exit 1)
  {
    const failingScript = `#!/usr/bin/env bash
echo "Validation error: invalid token format" >&2
exit 1
`;
    const staged = await stageOperatorAction({
      title: "Failing Action",
      explanation: "Expected failure test",
      actionType: "command",
      targetMachine: "infer1",
      scriptContent: failingScript,
      baseDir,
      tmpDir,
    });

    const result = spawnSync("bash", [staged.shortPath], { encoding: "utf8" });
    assert.equal(result.status, 1, "Process should exit with code 1");

    const check = await checkOperatorAction({ actionId: staged.actionId, baseDir });
    assert.equal(check.status, "failed");
    assert.equal(check.verified, false);
    assert.equal(check.exitCode, 1);
    assert.ok(check.error.includes("code 1"), "Error message should mention exit code");
    assert.ok(check.completedAt !== null);

    await cleanupOperatorAction({ actionId: staged.actionId, baseDir });
  }

  // Test 6: Lifecycle - Cancelled flow via signal (exit 130)
  {
    const cancellingScript = `#!/usr/bin/env bash
echo "Cancelled by operator" >&2
exit 130
`;
    const staged = await stageOperatorAction({
      title: "Interrupt Action",
      explanation: "Testing SIGINT / 130 handling",
      actionType: "command",
      targetMachine: "qq-box",
      scriptContent: cancellingScript,
      baseDir,
      tmpDir,
    });

    const result = spawnSync("bash", [staged.shortPath], { encoding: "utf8" });
    assert.equal(result.status, 130, "Process should exit with code 130");

    const check = await checkOperatorAction({ actionId: staged.actionId, baseDir });
    assert.equal(check.status, "cancelled");
    assert.equal(check.verified, false);
    assert.equal(check.exitCode, 130);

    await cleanupOperatorAction({ actionId: staged.actionId, baseDir });
  }

  // Test 7: Cancellation via API
  {
    const staged = await stageOperatorAction({
      title: "API Cancel Test",
      explanation: "Cancel before execution",
      actionType: "approval",
      targetMachine: "qq-box",
      scriptContent: "echo Should not run",
      baseDir,
      tmpDir,
    });

    const cancelRes = await cancelOperatorAction({
      actionId: staged.actionId,
      reason: "Operator changed mind",
      baseDir,
    });
    assert.equal(cancelRes.status, "cancelled");
    assert.equal(cancelRes.cancelled, true);

    // Attempt to run now cancelled action
    const runResult = spawnSync("bash", [staged.shortPath], { encoding: "utf8" });
    assert.equal(runResult.status, 1, "Cancelled action should refuse to execute");
    assert.ok(runResult.stderr.includes("cancelled"), "Should print cancellation warning");

    await cleanupOperatorAction({ actionId: staged.actionId, baseDir });
  }

  // Test 8: Safe cleanup protection of active actions
  {
    const staged = await stageOperatorAction({
      title: "Cleanup Protection Test",
      explanation: "Active action cleanup guard",
      actionType: "command",
      targetMachine: "qq-box",
      scriptContent: "echo ok",
      baseDir,
      tmpDir,
    });

    // Cleanup without force should throw while pending
    await assert.rejects(
      cleanupOperatorAction({ actionId: staged.actionId, force: false, baseDir }),
      /Cannot cleanup active action in 'pending' state/
    );

    // Cleanup with force: true should succeed
    const cleanRes = await cleanupOperatorAction({ actionId: staged.actionId, force: true, baseDir });
    assert.equal(cleanRes.cleaned, true);
    assert.ok(!existsSync(staged.actionDir));
  }

  // Test 9: Compatibility with existing external script (scriptPath)
  {
    const externalScriptPath = join(tempRoot, "external-helper.sh");
    writeFileSync(externalScriptPath, "#!/usr/bin/env bash\necho 'External script executed'\n", { mode: 0o755 });

    const staged = await stageOperatorAction({
      title: "External Script Integration",
      explanation: "Run external script",
      actionType: "command",
      targetMachine: "qq-box",
      scriptPath: externalScriptPath,
      baseDir,
      tmpDir,
    });

    assert.equal(staged.targetExecutable, externalScriptPath);
    const result = spawnSync("bash", [staged.shortPath], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("External script executed"));

    const check = await checkOperatorAction({ actionId: staged.actionId, baseDir });
    assert.equal(check.status, "succeeded");
    assert.equal(check.verified, true);

    await cleanupOperatorAction({ actionId: staged.actionId, baseDir });
    assert.ok(existsSync(externalScriptPath), "External script must NOT be deleted by cleanup!");
  }

    // Test 10: Staging real /tmp/jev-key helper without executing or modifying it
  if (existsSync("/tmp/jev-key")) {
    const staged = await stageOperatorAction({
      title: "TypeSafe API Key Setup",
      explanation: "Diagnostic credential configuration",
      actionType: "secret_entry",
      targetMachine: "qq-box",
      scriptPath: "/tmp/jev-key",
      baseDir,
      tmpDir,
    });

    assert.equal(staged.status, "pending");
    assert.equal(staged.targetMachine, "qq-box");
    assert.equal(staged.targetExecutable, "/tmp/jev-key");

    const check = await checkOperatorAction({ actionId: staged.actionId, baseDir });
    assert.equal(check.status, "pending");
    assert.equal(check.verified, false);

    // Cancel and cleanup
    await cancelOperatorAction({ actionId: staged.actionId, baseDir });
    await cleanupOperatorAction({ actionId: staged.actionId, baseDir });

    // CRUCIAL: /tmp/jev-key must still exist and be intact!
    assert.ok(existsSync("/tmp/jev-key"), "/tmp/jev-key must never be deleted by cleanup!");
  }

  
  // Test 11: MCP Server RPC Integration (tools/list and tools/call)
  {
    const { handleRpc } = await import("../bin/mcp-server.mjs");

    // tools/list without enableOperatorAction returns core tools
    const listCore = await handleRpc("tools/list");
    assert.equal(listCore.tools.some(t => t.name === "stage_operator_action"), false);

    // tools/list with enableOperatorAction returns operator action tools
    const listWithOp = await handleRpc("tools/list", {}, { enableOperatorAction: true });
    assert.ok(listWithOp.tools.some(t => t.name === "stage_operator_action"));
    assert.ok(listWithOp.tools.some(t => t.name === "check_operator_action"));
    assert.ok(listWithOp.tools.some(t => t.name === "cancel_operator_action"));
    assert.ok(listWithOp.tools.some(t => t.name === "cleanup_operator_action"));

    // tools/call: stage_operator_action
    const stageRpc = await handleRpc("tools/call", {
      name: "stage_operator_action",
      arguments: {
        title: "RPC Test",
        explanation: "Testing RPC tool surface",
        actionType: "command",
        targetMachine: "infer1",
        scriptContent: "echo rpc-ok",
        baseDir,
        tmpDir,
      },
    }, { enableOperatorAction: true });

    assert.equal(stageRpc.isError, undefined);
    const stageData = JSON.parse(stageRpc.content[0].text);
    assert.equal(stageData.targetMachine, "infer1");
    assert.equal(stageData.status, "pending");

    // tools/call: check_operator_action
    const checkRpc = await handleRpc("tools/call", {
      name: "check_operator_action",
      arguments: { actionId: stageData.actionId, baseDir },
    }, { enableOperatorAction: true });
    const checkData = JSON.parse(checkRpc.content[0].text);
    assert.equal(checkData.status, "pending");

    // tools/call: cancel_operator_action
    const cancelRpc = await handleRpc("tools/call", {
      name: "cancel_operator_action",
      arguments: { actionId: stageData.actionId, reason: "Testing RPC cancel", baseDir },
    }, { enableOperatorAction: true });
    const cancelData = JSON.parse(cancelRpc.content[0].text);
    assert.equal(cancelData.status, "cancelled");

    // tools/call: cleanup_operator_action
    const cleanupRpc = await handleRpc("tools/call", {
      name: "cleanup_operator_action",
      arguments: { actionId: stageData.actionId, baseDir },
    }, { enableOperatorAction: true });
    const cleanupData = JSON.parse(cleanupRpc.content[0].text);
    assert.equal(cleanupData.cleaned, true);
  }

  // Test 12: Disabled feature tools cannot be invoked bypassing tools/list
  {
    const { handleRpc } = await import("../bin/mcp-server.mjs");
    const oldEnv = process.env.QQ_ENABLE_OPERATOR_ACTION;
    delete process.env.QQ_ENABLE_OPERATOR_ACTION;
    try {
      const callDisabled = await handleRpc("tools/call", {
        name: "stage_operator_action",
        arguments: {
          title: "Disabled Call",
          explanation: "Should fail",
          targetMachine: "qq-box",
          scriptContent: "echo no",
        },
      });
      assert.equal(callDisabled.isError, true, "Disabled tool call must return isError: true");
      assert.match(callDisabled.content[0].text, /disabled/, "Error message must state tool is disabled");
    } finally {
      if (oldEnv !== undefined) process.env.QQ_ENABLE_OPERATOR_ACTION = oldEnv;
    }
  }

  // Test 13: Unique /tmp trampoline creation and symlink attack prevention
  {
    const sentinel = join(tempRoot, "sensitive-file.txt");
    writeFileSync(sentinel, "DO NOT OVERWRITE", { encoding: "utf8" });

    const staged1 = await stageOperatorAction({
      title: "Symlink Safety",
      explanation: "Ensure symlink targets are never overwritten",
      actionType: "command",
      targetMachine: "qq-box",
      scriptContent: "echo ok",
      baseDir,
      tmpDir,
    });

    const symlinkPath = join(tmpDir, "qqa-symtest1");
    symlinkSync(sentinel, symlinkPath);

    const staged2 = await stageOperatorAction({
      title: "Symlink Safety 2",
      explanation: "Testing allocation with existing symlink",
      actionType: "command",
      targetMachine: "qq-box",
      scriptContent: "echo ok2",
      baseDir,
      tmpDir,
    });

    assert.notEqual(staged2.shortPath, symlinkPath, "Must not allocate the symlink path");
    assert.equal(readFileSync(sentinel, "utf8"), "DO NOT OVERWRITE", "Sentinel file must remain untouched");

    await cleanupOperatorAction({ actionId: staged1.actionId, force: true, baseDir, tmpDir });
    await cleanupOperatorAction({ actionId: staged2.actionId, force: true, baseDir, tmpDir });
  }

  // Test 14: Process cancellation lifetime truthfulness & no process resurrection
  {
    const slowScript = `#!/usr/bin/env bash
sleep 5
echo "finished-slow-script"
`;
    const staged = await stageOperatorAction({
      title: "Slow Script Cancellation",
      explanation: "Testing truthful lifetime and no resurrection",
      actionType: "command",
      targetMachine: "qq-box",
      scriptContent: slowScript,
      baseDir,
      tmpDir,
    });

    const child = spawn("bash", [staged.shortPath], { stdio: "pipe" });

    let isRunning = false;
    for (let i = 0; i < 30; i++) {
      const st = await checkOperatorAction({ actionId: staged.actionId, baseDir });
      if (st.status === "running") {
        isRunning = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(isRunning, "Action must enter running state");

    const cancelRes = await cancelOperatorAction({
      actionId: staged.actionId,
      reason: "Cancel while running",
      baseDir,
    });

    assert.ok(
      cancelRes.status === "cancellation_requested" || cancelRes.status === "cancelled",
      "Expected cancellation_requested or cancelled, got: " + cancelRes.status
    );

    await new Promise((resolve) => {
      child.on("exit", resolve);
    });

    const finalCheck = await checkOperatorAction({ actionId: staged.actionId, baseDir });
    assert.equal(finalCheck.status, "cancelled", "Action must be cancelled after process death");
    assert.equal(finalCheck.verified, false, "Verified must be false");
    assert.equal(finalCheck.exitCode, 130);

    await cleanupOperatorAction({ actionId: staged.actionId, baseDir, tmpDir });
  }

  // Test 15: Duplicate execution prevention
  {
    const slowScript = `#!/usr/bin/env bash
sleep 2
echo "done"
`;
    const staged = await stageOperatorAction({
      title: "Duplicate Execution Guard",
      explanation: "Prevent duplicate concurrent or repeated execution",
      actionType: "command",
      targetMachine: "qq-box",
      scriptContent: slowScript,
      baseDir,
      tmpDir,
    });

    const child1 = spawn("bash", [staged.shortPath], { stdio: "pipe" });

    for (let i = 0; i < 30; i++) {
      const st = await checkOperatorAction({ actionId: staged.actionId, baseDir });
      if (st.status === "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const run2 = spawnSync("bash", [staged.shortPath], { encoding: "utf8" });
    assert.notEqual(run2.status, 0, "Duplicate concurrent run must fail");
    assert.match(run2.stderr, /already running/, "Error message must state already running");

    await new Promise((resolve) => {
      child1.on("exit", resolve);
    });

    const checkSucceeded = await checkOperatorAction({ actionId: staged.actionId, baseDir });
    assert.equal(checkSucceeded.status, "succeeded");

    const run3 = spawnSync("bash", [staged.shortPath], { encoding: "utf8" });
    assert.equal(run3.status, 0, "Repeated run on succeeded action must exit cleanly without re-executing");
    assert.match(run3.stderr, /already succeeded/, "Must report already succeeded");

    await cleanupOperatorAction({ actionId: staged.actionId, baseDir, tmpDir });
  }

  // Test 16: Active action cleanup guard and force termination
  {
    const slowScript = `#!/usr/bin/env bash
sleep 10
`;
    const staged = await stageOperatorAction({
      title: "Cleanup Force Termination",
      explanation: "Testing force cleanup kills running process",
      actionType: "command",
      targetMachine: "qq-box",
      scriptContent: slowScript,
      baseDir,
      tmpDir,
    });

    const child = spawn("bash", [staged.shortPath], { stdio: "pipe" });

    for (let i = 0; i < 30; i++) {
      const st = await checkOperatorAction({ actionId: staged.actionId, baseDir });
      if (st.status === "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    await assert.rejects(
      cleanupOperatorAction({ actionId: staged.actionId, force: false, baseDir, tmpDir }),
      /Cannot cleanup active action/,
      "Cleanup without force must throw while running"
    );

    const cleanRes = await cleanupOperatorAction({ actionId: staged.actionId, force: true, baseDir, tmpDir });
    assert.equal(cleanRes.cleaned, true);

    await new Promise((resolve) => {
      child.on("exit", resolve);
    });
    assert.ok(!existsSync(staged.actionDir), "Action dir must be removed");
    assert.ok(!existsSync(staged.shortPath), "Trampoline must be removed");
  }

  // Test 17: Terminal state cancellation immutability
  {
    const staged = await stageOperatorAction({
      title: "Completed Action Cancel Guard",
      explanation: "Testing that already succeeded action cannot be cancelled",
      actionType: "command",
      targetMachine: "qq-box",
      scriptContent: "echo all-done",
      baseDir,
      tmpDir,
    });

    const runRes = spawnSync("bash", [staged.shortPath], { encoding: "utf8" });
    assert.equal(runRes.status, 0);

    const check = await checkOperatorAction({ actionId: staged.actionId, baseDir });
    assert.equal(check.status, "succeeded");

    const cancelRes = await cancelOperatorAction({ actionId: staged.actionId, baseDir });
    assert.equal(cancelRes.status, "succeeded");
    assert.equal(cancelRes.cancelled, false);
    assert.match(cancelRes.message, /already succeeded/);

    await cleanupOperatorAction({ actionId: staged.actionId, baseDir, tmpDir });
  }

  console.log("All operator-action tests passed cleanly!");
} finally {
  try {
    await rm(tempRoot, { recursive: true, force: true });
  } catch {}
}
