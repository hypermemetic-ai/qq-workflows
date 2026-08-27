import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export const QA_VERDICT_SCHEMA = "qq.qa-verdict/v1";
export const QA_VERDICT_ARGUMENT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["verdict", "summary", "feedback", "tests_modified"]),
  properties: Object.freeze({
    verdict: Object.freeze({ type: "string", enum: Object.freeze(["pass", "fail"]) }),
    summary: Object.freeze({ type: "string", minLength: 1, maxLength: 240 }),
    feedback: Object.freeze({ type: "string", maxLength: 8000 }),
    tests_modified: Object.freeze({ type: "boolean" }),
  }),
});

const ARGUMENT_KEYS = Object.freeze(["feedback", "summary", "tests_modified", "verdict"]);
const RECORD_KEYS = Object.freeze(["createdAt", "feedback", "schema", "summary", "tests_modified", "verdict", "version"]);

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

export function validateQaVerdictInput(value) {
  if (!exactKeys(value, ARGUMENT_KEYS)) throw new Error("qa verdict has the wrong fields");
  if (value.verdict !== "pass" && value.verdict !== "fail") throw new Error("qa verdict must be pass or fail");
  if (typeof value.summary !== "string" || value.summary.length < 1 || value.summary.length > 240) throw new Error("qa verdict summary is invalid");
  if (typeof value.feedback !== "string" || value.feedback.length > 8000) throw new Error("qa verdict feedback is invalid");
  if (typeof value.tests_modified !== "boolean") throw new Error("qa verdict tests_modified is invalid");
  return value;
}

export function createQaVerdict(value, options = {}) {
  validateQaVerdictInput(value);
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new Error("qa verdict createdAt is invalid");
  return {
    schema: QA_VERDICT_SCHEMA,
    version: 1,
    verdict: value.verdict,
    summary: value.summary,
    feedback: value.feedback,
    tests_modified: value.tests_modified,
    createdAt,
  };
}

export function validateQaVerdictRecord(value) {
  if (!exactKeys(value, RECORD_KEYS) || value.schema !== QA_VERDICT_SCHEMA || value.version !== 1) {
    throw new Error("qa verdict record is malformed");
  }
  validateQaVerdictInput({
    verdict: value.verdict,
    summary: value.summary,
    feedback: value.feedback,
    tests_modified: value.tests_modified,
  });
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) throw new Error("qa verdict createdAt is invalid");
  return value;
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error("qa verdict directory is unsafe");
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700);
}

export async function writeQaVerdict(path, value) {
  validateQaVerdictRecord(value);
  const root = dirname(path);
  await privateDirectory(root);
  const temporary = join(root, `.${randomUUID()}.qa-verdict.tmp`);
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    temporaryExists = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try { await link(temporary, path); }
    catch (error) {
      if (error?.code === "EEXIST") throw new Error("qa verdict was already submitted");
      throw error;
    }
    await unlink(temporary);
    temporaryExists = false;
    const directory = await open(root, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close();
    if (temporaryExists) await unlink(temporary).catch(() => {});
  }
  return value;
}
