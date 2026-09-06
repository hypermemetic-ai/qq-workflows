#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  loadResearchSecrets,
  parseCredentialsYaml,
  withResearchSecrets,
} from "../paseo-plugin/host/providers/secrets.mjs";

assert.deepEqual(
  parseCredentialsYaml("BRAVE_API_KEY: abc\nEXA_API_KEY: 'def'\nOTHER: nope\n"),
  { BRAVE_API_KEY: "abc", EXA_API_KEY: "def" },
);

const fromEnv = loadResearchSecrets({
  env: { BRAVE_API_KEY: "env-brave", HOME: "/tmp" },
  home: "/tmp",
  readFileFn: () => "BRAVE_API_KEY: file-brave\nEXA_API_KEY: file-exa\n",
});
assert.equal(fromEnv.BRAVE_API_KEY, "env-brave");
assert.equal(fromEnv.EXA_API_KEY, "file-exa");

const missing = loadResearchSecrets({
  env: {},
  home: "/tmp",
  readFileFn: () => { throw new Error("ENOENT"); },
});
assert.equal(missing.BRAVE_API_KEY, undefined);

const merged = withResearchSecrets({ PATH: "/bin", BRAVE_API_KEY: "x" });
assert.equal(merged.PATH, "/bin");
assert.equal(merged.BRAVE_API_KEY, "x");

import { loadGrokToken } from "../paseo-plugin/host/providers/secrets.mjs";
assert.equal(await loadGrokToken({ XAI_API_KEY: "tok" }), "tok");
