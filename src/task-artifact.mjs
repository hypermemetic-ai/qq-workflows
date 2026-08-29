// Exact implementation task access for fresh workflow phases.
//
// Task bytes remain in active durable delegation state and are materialized
// beneath Git's private metadata directory. This keeps workflow metadata out of
// `git status` while allowing every fresh child in the delegated capsule to
// read the exact task. The host rewrites and verifies the artifact before each
// handoff because a delegated child can modify files under .git.

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const TASK_ARTIFACT_SCHEMA = "qq.task-artifact/v1";
export const TASK_ARTIFACT_RELATIVE_PATH = ".git/qq-workflows/task.md";
const SHA256 = /^[0-9a-f]{64}$/;

export function taskDigest(task) {
  return createHash("sha256").update(String(task ?? ""), "utf8").digest("hex");
}

function commandReason(result, fallback) {
  return result?.stderr?.trim() || result?.stdout?.trim() || fallback;
}

async function gitDirectory(run, worktree) {
  const result = await run("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree });
  if (result?.code !== 0) throw new Error(`cannot resolve task artifact Git directory: ${commandReason(result, "git rev-parse failed")}`);
  const value = result.stdout.trim();
  if (!value) throw new Error("cannot resolve task artifact Git directory: empty path");
  return resolve(worktree, value);
}

function childPointer(worktree, artifactPath) {
  const rel = relative(worktree, artifactPath);
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel;
  return artifactPath;
}

async function writePrivateAtomic(path, contents) {
  const directory = resolve(path, "..");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      // Remove the metadata entry itself, never a symlink target.
      await rm(directory, { recursive: true, force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("task artifact directory is unsafe");
  }
  if (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid()) {
    throw new Error("task artifact directory is not owned by this user");
  }
  await chmod(directory, 0o700);
  const temporary = join(directory, `.task.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Rematerialize exact durable task bytes and verify the resulting artifact. */
export async function materializeTaskArtifact(run, { worktree, task, expectedDigest } = {}) {
  if (typeof run !== "function") throw new Error("task artifact requires a command runner");
  if (typeof worktree !== "string" || !worktree) throw new Error("task artifact requires a worktree");
  const contents = String(task ?? "");
  const digest = taskDigest(contents);
  if (expectedDigest && (!SHA256.test(expectedDigest) || expectedDigest !== digest)) {
    throw new Error("durable task does not match its recorded digest");
  }
  const gitDir = await gitDirectory(run, worktree);
  const artifactPath = join(gitDir, "qq-workflows", "task.md");
  await writePrivateAtomic(artifactPath, contents);
  const verified = await readFile(artifactPath, "utf8");
  if (verified !== contents || taskDigest(verified) !== digest) {
    throw new Error("task artifact integrity verification failed");
  }
  return Object.freeze({
    schema: TASK_ARTIFACT_SCHEMA,
    path: artifactPath,
    pointer: childPointer(resolve(worktree), artifactPath),
    sha256: digest,
    bytes: Buffer.byteLength(contents, "utf8"),
  });
}
