#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  architectTools,
  DELEGATE,
  teacherFirstUserMessage,
  TICKET_READ,
  TICKET_WRITE,
  TEACHER,
  teacherTools,
  researcherTools,
  roleTools,
  validateDelegateArgs,
} from "../paseo-plugin/host/workflow/tools.mjs";
import { ZG_WHITELIST, ZVEC_GREP_RG, ZVEC_GREP_SEARCH } from "../paseo-plugin/host/search/zg-tools.mjs";

const names = architectTools().map((tool) => tool.name);
assert.deepEqual(names.includes("ticket_read"), false);
assert.ok(names.includes("ticket_write"));
assert.ok(names.includes("teacher"));
assert.ok(names.includes("delegate"));
assert.ok(names.includes("zvec_grep_search"));
assert.ok(names.includes("zvec_grep_rg"));

assert.match(TICKET_WRITE.description, /Only `\.architect\/ticket\.md`/);
assert.match(TICKET_READ.description, /Same path, same create-from-template/);
assert.match(TEACHER.description, /parked_question/);
assert.match(DELEGATE.description, /bounded or open/);
assert.equal(ZVEC_GREP_SEARCH.name, "zvec_grep_search");
assert.equal(ZVEC_GREP_RG.name, "zvec_grep_rg");
assert.ok(ZG_WHITELIST.includes("zvec_grep_rg"));
assert.ok(teacherTools().some((tool) => tool.name === "ticket_read"));
assert.deepEqual(roleTools('teacher'), teacherTools());
assert.deepEqual(roleTools('architect'), architectTools());
assert.deepEqual(roleTools('unknown'), []);
assert.deepEqual(roleTools('implementer').map(tool => tool.name), ['done']);
assert.deepEqual(ZG_WHITELIST, ['zvec_grep_search', 'zvec_grep_rg']);

const first = teacherFirstUserMessage({
  parked_question: "bounded or open?",
  direction: "kind",
  informed_enough: "can pick one",
});
assert.match(first, /^parked_question: bounded or open\?/m);
assert.match(first, /^direction: kind$/m);
assert.match(first, /^informed_enough: can pick one$/m);

assert.deepEqual(validateDelegateArgs({ to: "implementer", kind: "bounded" }, "bounded"), {
  to: "implementer",
  kind: "bounded",
});
assert.throws(() => validateDelegateArgs({ to: "implementer", kind: "open" }, "bounded"));
assert.throws(() => validateDelegateArgs({ to: "implementer" }));
assert.deepEqual(validateDelegateArgs({ to: "implementer", kind: "bounded", completion: "report" }), { to: "implementer", kind: "bounded", completion: "report" });
assert.throws(() => validateDelegateArgs({ to: "implementer", kind: "open", completion: "skip" }));
assert.throws(() => validateDelegateArgs({ to: "researcher" }));
assert.deepEqual(validateDelegateArgs({ to: "researcher", question: "What is ACP?" }), {
  to: "researcher",
  question: "What is ACP?",
});

assert.deepEqual(
  researcherTools().map((tool) => tool.name),
  [
    "brave_search",
    "exa_search",
    "visit_webpage",
    "zvec_grep_search",
    "zvec_grep_rg",
    "run_command",
    "start_service",
    "service_status",
    "stop_service",
    "done",
  ],
);
assert.match(researcherTools().find((tool) => tool.name === "run_command").description, /bash -c/);
