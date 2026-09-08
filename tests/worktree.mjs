#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorktreeIndex, implementerBranchName } from "../workflow/worktree.mjs";

const dir = mkdtempSync(join(tmpdir(), "architect-worktree-test-"));

try {
  // Test implementerBranchName
  assert.equal(implementerBranchName("feat", "1234567890"), "architect/feat/12345678");

  // Setup mock source workspace with .zvec-grep
  const sourceCwd = join(dir, "source-repo");
  const targetCwd = join(dir, "target-worktree");
  mkdirSync(join(sourceCwd, ".zvec-grep", "locks"), { recursive: true });
  mkdirSync(targetCwd, { recursive: true });

  const initialManifest = {
    manifestVersion: 1,
    id: "test-id-123",
    name: "test-source",
    path: join(sourceCwd, ".zvec-grep"),
    rootPaths: [{ absolutePath: sourceCwd, recursive: true }],
    embedding: { model: "local/qwen3-embedding-0.6b" },
  };
  writeFileSync(join(sourceCwd, ".zvec-grep", "manifest.json"), JSON.stringify(initialManifest, null, 2));
  writeFileSync(join(sourceCwd, ".zvec-grep", "locks", "daemon.json"), "mock-lock");

  // Run seedWorktreeIndex
  const seeded = await seedWorktreeIndex({ sourceCwd, targetCwd });
  assert.equal(seeded, true, "seedWorktreeIndex should report success");

  // Verify target structure
  const targetManifestPath = join(targetCwd, ".zvec-grep", "manifest.json");
  assert.ok(existsSync(targetManifestPath), "Target manifest must exist");

  const targetManifest = JSON.parse(readFileSync(targetManifestPath, "utf8"));
  assert.equal(targetManifest.path, join(targetCwd, ".zvec-grep"));
  assert.equal(targetManifest.rootPaths[0].absolutePath, targetCwd);

  // Verify stale locks were cleaned up
  const staleLockPath = join(targetCwd, ".zvec-grep", "locks", "daemon.json");
  assert.equal(existsSync(staleLockPath), false, "Stale locks should be purged");
  assert.ok(existsSync(join(targetCwd, ".zvec-grep", "locks")), "Locks directory should exist and be clean");

  // Second invocation should safely no-op
  const secondRun = await seedWorktreeIndex({ sourceCwd, targetCwd });
  assert.equal(secondRun, false, "Second run should no-op because target .zvec-grep already exists");

  console.log("Worktree tests passed successfully.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
