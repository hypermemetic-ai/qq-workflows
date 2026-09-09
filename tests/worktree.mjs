#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorktreeIndex, implementerBranchName } from "../workflow/worktree.mjs";
import {
  cleanWorktreeProjects,
  createWorktree,
  git,
  landWorktree,
  retireWorktree,
} from "../workflow/git.mjs";

const dir = mkdtempSync(join(tmpdir(), "architect-worktree-test-"));

try {
  // Test implementerBranchName
  assert.equal(implementerBranchName("feat", "1234567890"), "architect/feat/12345678");
  assert.equal(implementerBranchName("research", "1234567890"), "architect/research/12345678");

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

  // --- Test retireWorktree & landWorktree Project Cleanup ---
  const projectsDir = join(homedir(), ".gemini", "config", "projects");
  mkdirSync(projectsDir, { recursive: true });

  const testRepo = join(dir, "cleanup-test-repo");
  mkdirSync(testRepo, { recursive: true });
  await git(testRepo, ["init", "-b", "main"]);
  await git(testRepo, ["config", "user.name", "Clean Test"]);
  await git(testRepo, ["config", "user.email", "clean@example.invalid"]);
  writeFileSync(join(testRepo, "initial.txt"), "hello\n");
  await git(testRepo, ["add", "initial.txt"]);
  await git(testRepo, ["commit", "-m", "init"]);

  // 1. Test retireWorktree cleanup with matching gitFolder and resource folderUri
  const wt = await createWorktree(testRepo, { kind: "bounded", sessionId: "cleanup-retire-1" });
  const id1 = `test-clean-gitfolder-${Date.now()}`;
  const id2 = `test-clean-resource-${Date.now()}`;
  const id3 = `test-clean-unrelated-${Date.now()}`;
  const file1 = join(projectsDir, `${id1}.json`);
  const file2 = join(projectsDir, `${id2}.json`);
  const file3 = join(projectsDir, `${id3}.json`);

  try {
    writeFileSync(
      file1,
      JSON.stringify({
        id: id1,
        name: "Test Git Folder Project",
        projectResources: {
          resources: [
            {
              gitFolder: {
                folderUri: `file://${wt.cwd}`,
                defaultBranch: "main",
              },
            },
          ],
        },
        settings: {},
        isWorkspaceOnly: false,
      }),
    );

    writeFileSync(
      file2,
      JSON.stringify({
        id: id2,
        name: "Test Resource Folder Project",
        projectResources: {
          resources: [
            {
              folderUri: `file://${wt.cwd}`,
            },
          ],
        },
        settings: {},
        isWorkspaceOnly: false,
      }),
    );

    writeFileSync(
      file3,
      JSON.stringify({
        id: id3,
        name: "Test Unrelated Project",
        projectResources: {
          resources: [
            {
              folderUri: "file:///some/unrelated/directory",
            },
          ],
        },
        settings: {},
        isWorkspaceOnly: false,
      }),
    );

    assert.ok(existsSync(file1), "file1 should exist before retireWorktree");
    assert.ok(existsSync(file2), "file2 should exist before retireWorktree");
    assert.ok(existsSync(file3), "file3 should exist before retireWorktree");

    await retireWorktree(testRepo, { worktree: wt.cwd, branch: wt.branch });

    assert.equal(existsSync(file1), false, "gitFolder matching project JSON should be unlinked by retireWorktree");
    assert.equal(existsSync(file2), false, "resources[] folderUri matching project JSON should be unlinked by retireWorktree");
    assert.equal(existsSync(file3), true, "unrelated project JSON should remain untouched");
  } finally {
    if (existsSync(file1)) rmSync(file1, { force: true });
    if (existsSync(file2)) rmSync(file2, { force: true });
    if (existsSync(file3)) rmSync(file3, { force: true });
  }

  // 2. Test landWorktree project cleanup
  const wtLand = await createWorktree(testRepo, { kind: "bounded", sessionId: "cleanup-land-1" });
  const idLand = `test-clean-land-${Date.now()}`;
  const fileLand = join(projectsDir, `${idLand}.json`);

  try {
    writeFileSync(
      fileLand,
      JSON.stringify({
        id: idLand,
        name: "Test Land Project",
        projectResources: {
          resources: [
            {
              gitFolder: {
                folderUri: `file://${wtLand.cwd}`,
              },
            },
          ],
        },
        settings: {},
        isWorkspaceOnly: false,
      }),
    );

    writeFileSync(join(wtLand.cwd, "feature.txt"), "feature code\n");
    await landWorktree(testRepo, {
      worktree: wtLand.cwd,
      branch: wtLand.branch,
      message: "feat: add feature",
    });

    assert.equal(existsSync(fileLand), false, "landWorktree should clean up matching project JSON");
  } finally {
    if (existsSync(fileLand)) rmSync(fileLand, { force: true });
  }

  // 3. Test direct cleanWorktreeProjects with no matching path
  const unlinkedNonExistent = await cleanWorktreeProjects(testRepo, "/nonexistent/test/path");
  assert.deepEqual(unlinkedNonExistent, []);

  console.log("Worktree tests passed successfully.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
