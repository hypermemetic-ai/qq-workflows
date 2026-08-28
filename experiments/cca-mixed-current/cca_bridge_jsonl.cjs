"use strict";
const readline = require("readline");
const path = require("path");

let loadedRoot = null;
let compressObservation = null;

function load(root) {
  if (root === loadedRoot && compressObservation) return;
  const pkg = require(path.join(root, "package.json"));
  if (pkg.name !== "@linger-alpha/cca" || pkg.version !== "0.2.0") {
    throw new Error("unexpected CCA pin");
  }
  ({ compressObservation } = require(path.join(root, "src/compression/compressor.js")));
  loadedRoot = root;
}

function evaluate(payload) {
  load(payload.ccaRoot);
  const result = compressObservation({
    command: payload.command,
    stdout: payload.stdout,
    stderr: "",
    exitCode: payload.exitCode,
    agent: "historical-corpus-offline",
    toolName: "bash",
  }, { rawDir: payload.rawDir });
  return {
    ok: true,
    changed: result.changed,
    text: result.text,
    ruleIds: result.ruleIds,
    critical: result.critical,
    rawChars: result.rawChars,
    compressedChars: result.compressedChars,
  };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  try {
    process.stdout.write(`${JSON.stringify(evaluate(JSON.parse(line)))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      errorName: error?.name ?? "Error",
      errorMessage: error?.message ?? String(error),
    })}\n`);
  }
});
