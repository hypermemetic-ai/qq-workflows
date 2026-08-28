"use strict";
const fs = require("fs");
const path = require("path");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const payload = JSON.parse(raw);
  const pkg = require(path.join(payload.ccaRoot, "package.json"));
  if (pkg.name !== "@linger-alpha/cca" || pkg.version !== "0.2.0") throw new Error("unexpected CCA pin");
  const { compressObservation } = require(path.join(payload.ccaRoot, "src/compression/compressor.js"));
  const result = compressObservation({
    command: payload.command,
    stdout: payload.stdout,
    stderr: "",
    exitCode: payload.exitCode,
    agent: "historical-corpus-offline",
    toolName: "bash",
  }, { rawDir: payload.rawDir });
  process.stdout.write(JSON.stringify({
    changed: result.changed,
    text: result.text,
    ruleIds: result.ruleIds,
    critical: result.critical,
    rawChars: result.rawChars,
    compressedChars: result.compressedChars,
  }));
});
