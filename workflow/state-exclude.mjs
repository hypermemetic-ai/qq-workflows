// Register the operational state ignore at workflow initialization, not at
// every (pure) stateDirFor lookup. Git's effective info/exclude may live in
// common metadata rather than beside a linked worktree's .git file.
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const STATE_EXCLUDE_RULE = "/.architect/state/";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "pipe"] }).trim();
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function registerStateExclude(root, stateDir, { warn = message => console.warn(`[qq-workflows] ${message}`) } = {}) {
  const skipped = reason => ({ status: "skipped", reason });
  const warning = error => {
    const reason = String(error?.message ?? error).slice(0, 240);
    warn(`could not register Git state exclusion: ${reason}`);
    return { status: "warning", reason };
  };
  let lock;
  let lockOwned = false;
  try {
    if (resolve(stateDir) !== resolve(root, ".architect", "state")) return skipped("custom state directory");
    // A symlink in the operational path would cause the rule to suppress a
    // different location. Refuse rather than masking unrelated data.
    for (const path of [join(root, ".architect"), join(root, ".architect", "state")]) {
      try { if (lstatSync(path).isSymbolicLink()) return skipped("symlinked state directory"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    let top;
    try {
      if (git(root, "rev-parse", "--is-inside-work-tree") !== "true") return skipped("not a Git worktree");
      top = git(root, "rev-parse", "--show-toplevel");
    } catch { return skipped("not a Git worktree"); }
    if (realpathSync(root) !== realpathSync(top)) return skipped("not the worktree root");
    const path = git(root, "rev-parse", "--git-path", "info/exclude");
    if (!path) throw new Error("Git returned no info/exclude path");
    const exclude = isAbsolute(path) ? path : resolve(root, path);
    mkdirSync(dirname(exclude), { recursive: true });
    lock = `${exclude}.qq-workflows.lock`;
    const deadline = Date.now() + 350;
    while (true) {
      try { mkdirSync(lock); lockOwned = true; break; }
      catch (error) {
        if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
        pause(20);
      }
    }
    let bytes;
    try { bytes = readFileSync(exclude); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      bytes = Buffer.alloc(0);
    }
    if (bytes.toString("utf8").split(/\r?\n/).includes(STATE_EXCLUDE_RULE)) return { status: "present", path: exclude };
    const prefix = bytes.length && bytes[bytes.length - 1] !== 10 ? "\n" : "";
    // O_APPEND preserves other lines and never truncates user rules. Our small
    // per-exclude lock serializes concurrent workflow registrations.
    const fd = openSync(exclude, "a");
    try {
      if (bytes.length && (fstatSync(fd).ino !== statSync(exclude).ino || fstatSync(fd).size !== bytes.length)) {
        throw new Error("info/exclude changed during registration");
      }
      const line = `${prefix}${STATE_EXCLUDE_RULE}\n`;
      if (writeSync(fd, line) !== Buffer.byteLength(line)) throw new Error("short info/exclude write");
    } finally { closeSync(fd); }
    return { status: "registered", path: exclude };
  } catch (error) {
    return warning(error);
  } finally {
    if (lockOwned) {
      try { rmdirSync(lock); }
      catch (error) { warning(error); }
    }
  }
}
