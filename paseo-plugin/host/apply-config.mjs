#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { applyDaemonPatch } from "./config.mjs";

const path = process.env.PASEO_HOME
  ? join(process.env.PASEO_HOME, "config.json")
  : join(homedir(), ".paseo", "config.json");
const current = JSON.parse(await readFile(path, "utf8"));
if (current.pluginsEnabled !== true) {
  throw new Error("pluginsEnabled is not true; refusing to edit daemon config");
}
const next = applyDaemonPatch(current);
await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
console.log(`patched ${path}`);
