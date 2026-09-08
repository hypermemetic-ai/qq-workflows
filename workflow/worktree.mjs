import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

function isRealCwd(cwd) {
  return typeof cwd === "string" && cwd.trim().length > 0;
}

const execFile = promisify(execFileCb);

export function implementerBranchName(kind, jobId) {
  return `architect/${kind}/${String(jobId).slice(0, 8)}`;
}

export async function seedWorktreeIndex({
  sourceCwd,
  targetCwd,
  execFileFn = execFile,
} = {}) {
  try {
    if (!isRealCwd(sourceCwd) || !isRealCwd(targetCwd)) return false;
    const sourceZg = join(sourceCwd, ".zvec-grep");
    const targetZg = join(targetCwd, ".zvec-grep");
    if (!existsSync(sourceZg) || existsSync(targetZg)) {
      return false;
    }

    try {
      await execFileFn("cp", ["-al", sourceZg, targetZg]);
    } catch {
      await execFileFn("cp", ["-r", sourceZg, targetZg]);
    }

    const locksDir = join(targetZg, "locks");
    if (existsSync(locksDir)) {
      rmSync(locksDir, { recursive: true, force: true });
      mkdirSync(locksDir, { recursive: true });
    }

    const manifestPath = join(targetZg, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.path = targetZg;
      manifest.rootPaths = [{ absolutePath: targetCwd, recursive: true }];
      manifest.updatedTime = Date.now();
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    return true;
  } catch {
    return false;
  }
}

export async function createImplementerWorktree({
  cwd,
  branch,
  paseo = null,
  reuse = false,
  execFileFn = execFile,
  home = homedir(),
} = {}) {
  if (!isRealCwd(cwd)) throw new Error("delegate: source cwd missing");
  if (!branch) throw new Error("delegate: worktree branch missing");
  if (reuse) {
    const { stdout } = await execFileFn("git", ["worktree", "list", "--porcelain", "-z"], { cwd, encoding: "utf8" });
    const entry = stdout.split("\0\0").map(record => record.split("\0"))
      .find(fields => fields.includes(`branch refs/heads/${branch}`));
    if (entry) {
      if (entry.some(field => /^(?:prunable|locked)(?: |$)/.test(field))) throw new Error("Prepared worktree is locked or unavailable; inspect before retrying");
      const path = entry.find(field => field.startsWith("worktree ")).slice(9);
      const actual = await execFileFn("git", ["-C", path, "branch", "--show-current"], { encoding: "utf8" });
      if (actual.stdout.trim() !== branch) throw new Error("Prepared worktree branch changed; inspect before retrying");
      return { cwd: path, workspaceId: null };
    }
  }
  if (paseo?.workspaces?.create) {
    const handle = await paseo.workspaces.create({
      title: `implementer ${branch}`,
      source: {
        kind: "worktree",
        cwd,
        action: "branch-off",
        branchName: branch,
      },
    });
    try {
      await handle.refresh?.();
    } catch {
      /* directory may already be present */
    }
    const directory = handle.directory ?? handle.cwd ?? null;
    if (!isRealCwd(directory)) throw new Error("delegate: worktree cwd did not appear");
    await seedWorktreeIndex({ sourceCwd: cwd, targetCwd: directory, execFileFn });
    return { cwd: directory, workspaceId: handle.id ?? null };
  }
  // A deterministic path lets recovery identify the worktree without creating another one.
  const paseoHome = process.env.PASEO_HOME || join(home, ".paseo");
  const dest = join(paseoHome, "worktrees", "architect", branch.replaceAll("/", "-"));
  await mkdir(dirname(dest), { recursive: true });
  await execFileFn("git", ["worktree", "add", "-b", branch, dest], { cwd, encoding: "utf8" });
  await seedWorktreeIndex({ sourceCwd: cwd, targetCwd: dest, execFileFn });
  return { cwd: dest, workspaceId: null };
}
