// Product adapter for SWE-agent/mini-swe-agent v2's official mini.yaml.
//
// Upstream: https://github.com/SWE-agent/mini-swe-agent
// Pin: 25941c89cfbc91eb40b3f8756348c91d9977d57e (v2.4.6 + main chores)
// Config: src/minisweagent/config/mini.yaml
// License: MIT, Copyright (c) 2025 Kilian A. Lieret and Carlos E. Jimenez.
//
// DSH owns model budgets/routing, approvals, durable sessions, sandboxed tool
// execution, relay, and Land. These strings and observation rules come from
// upstream v2; official completion is safely bridged to Land rather than
// launching the Python host or executing an untrusted submission sentinel.

import { machine, release, type, version } from "node:os";
import {
  OBSERVATION_HEAD_CHARS,
  OBSERVATION_MAX_CHARS,
  OBSERVATION_TAIL_CHARS,
} from "./observation.mjs";

export const MINI_SWE_REPOSITORY = "https://github.com/SWE-agent/mini-swe-agent";
export const MINI_SWE_SHA = "25941c89cfbc91eb40b3f8756348c91d9977d57e";
export const MINI_SWE_VERSION = "2.4.6";
export const MINI_SWE_CONFIG = "src/minisweagent/config/mini.yaml";
export const MINI_SWE_MIGRATION = "restart-required-for-live-pre-v2-mini";
export const MINI_SWE_COMPLETION_COMMAND = "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT";

export const MINI_SWE_SYSTEM_PROMPT = "You are a helpful assistant that can interact with a computer.";

/** Add dsh-tool-bash metadata at execution time without exposing it to the model schema. */
export function withNativeBashDescription(args, description = "Execute Mini bash command") {
  const input = args && typeof args === "object" ? args : {};
  if (typeof input.description === "string" && input.description.trim()) return input;
  return { ...input, description };
}

function systemInformation(info = {}) {
  return {
    system: info.system ?? type(),
    release: info.release ?? release(),
    version: info.version ?? version(),
    machine: info.machine ?? machine(),
  };
}

/** Render upstream mini.yaml's instance_template around qq's work packet. */
// DSH overlays this reminder on the packet template; it is not an upstream mini.yaml change or byte-identical to v2.
export function renderMiniSweTask(task, info) {
  const os = systemInformation(info);
  return [
    `Please solve this issue: ${String(task ?? "")}`,
    "",
    "You can execute bash commands and edit files to implement the necessary changes.",
    "This checkout has no writable Git metadata or network credentials. The host exclusively stages, commits, and publishes after QA.",
    "Do not push branches, open or merge pull requests, or merge into the base branch.",
    "",
    "## Recommended Workflow",
    "",
    "This workflow should be done step-by-step so that you can iterate on your changes and any possible problems.",
    "",
    "1. Analyze the codebase by finding and reading relevant files",
    "2. Create a script to reproduce the issue",
    "3. Edit the source code to resolve the issue",
    "4. Verify your fix works by running your script again",
    "5. Test edge cases to ensure your fix is robust",
    `6. Run relevant tests with bash as needed, then submit your ordinary file edits for host commit by issuing: \`${MINI_SWE_COMPLETION_COMMAND}\`.`,
    "   Do not combine it with any other command. <important>After this command, you cannot continue working on this task.</important>",
    "",
    "## Command Execution Rules",
    "",
    "You are operating in an environment where",
    "",
    "1. You issue at least one command",
    "2. The system executes the command(s) in a subshell",
    "3. You see the result(s)",
    "4. You write your next command(s)",
    "",
    "Each response should include:",
    "",
    "1. **Reasoning text** where you explain your analysis and plan",
    "2. At least one tool call with your command",
    "",
    "**CRITICAL REQUIREMENTS:**",
    "",
    "- Your response SHOULD include reasoning text explaining what you're doing",
    "- Your response MUST call bash, workflow_send, or the read-only session_history tool at least once",
    "- Use session_history only for compacted current-session context: search with 1–5 literal clues, expand an exact seq with context, then verify referenced files/current state",
    "- Directory or environment variable changes are not persistent. Every action is executed in a new subshell.",
    "- However, you can prefix any action with `MY_ENV_VAR=MY_VALUE cd /path/to/working/dir && ...` or write/load environment variables from files",
    `- Submit and finish by issuing the following command; the host stages and commits: \`${MINI_SWE_COMPLETION_COMMAND}\`.`,
    "  Do not combine it with any other command. <important>After this command, you cannot continue working on this task.</important>",
    "",
    "Example of a CORRECT response:",
    "<example_response>",
    "I need to understand the structure of the repository first. Let me check what files are in the current directory to get a better understanding of the codebase.",
    "",
    '[Makes bash tool call with {"command": "ls -la"} as arguments]',
    "</example_response>",
    "",
    "<system_information>",
    `${os.system} ${os.release} ${os.version} ${os.machine}`,
    "</system_information>",
    "",
    "## Useful command examples",
    "",
    "### Create a new file:",
    "",
    "```bash",
    "cat <<'EOF' > newfile.py",
    "import numpy as np",
    'hello = "world"',
    "print(hello)",
    "EOF",
    "```",
    "",
    "### Edit files with sed:",
    "",
    ...(os.system === "Darwin" ? [
      "<important>",
      "You are on MacOS. For all the below examples, you need to use `sed -i ''` instead of `sed -i`.",
      "</important>",
      "",
    ] : []),
    "```bash",
    "# Replace all occurrences",
    "sed -i 's/old_string/new_string/g' filename.py",
    "",
    "# Replace only first occurrence",
    "sed -i 's/old_string/new_string/' filename.py",
    "",
    "# Replace first occurrence on line 1",
    "sed -i '1s/old_string/new_string/' filename.py",
    "",
    "# Replace all occurrences in lines 1-10",
    "sed -i '1,10s/old_string/new_string/g' filename.py",
    "```",
    "",
    "### View file content:",
    "",
    "```bash",
    "# View specific lines with numbers",
    "nl -ba filename.py | sed -n '10,20p'",
    "```",
    "",
    "### Any other command you want to run",
    "",
    "```bash",
    "anything",
    "```",
  ].join("\n");
}

export function isMiniSweCompletionCommand(command) {
  return typeof command === "string" && command.trim() === MINI_SWE_COMPLETION_COMMAND;
}

/** Render upstream mini.yaml's JSON observation_template. */
export function renderMiniSweObservation({ output = "", returncode = 0, exception_info = "" } = {}) {
  const text = String(output ?? "");
  const points = Array.from(text);
  const observation = points.length < OBSERVATION_MAX_CHARS
    ? { returncode, output: text }
    : {
      returncode,
      output_head: points.slice(0, OBSERVATION_HEAD_CHARS).join(""),
      output_tail: points.slice(-OBSERVATION_TAIL_CHARS).join(""),
      elided_chars: points.length - OBSERVATION_MAX_CHARS,
      warning: "Output too long.",
    };
  if (exception_info) observation.exception_info = String(exception_info);
  return JSON.stringify(observation, null, 2);
}

export const MINI_SWE_BASH_SCHEMA = Object.freeze({
  description: "Execute a bash command",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      command: Object.freeze({
        type: "string",
        description: "The bash command to execute",
      }),
    }),
    required: Object.freeze(["command"]),
  }),
});
