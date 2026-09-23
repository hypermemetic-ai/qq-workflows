#!/usr/bin/env node
// Real native pi/operation and MCP dispatch, fake only at retrieval backend boundary.
import assert from 'node:assert/strict';
import { createArchitectExtension } from '../pi-extension/qq-architect.mjs';
import { createWorkflow, WORKFLOW_TOOLS } from '../workflow/operations.mjs';
import { callTool, TOOLS } from '../bin/mcp-server.mjs';
import { buildCorpusRepo, fakeBackendFactory, tmpStateDir } from './fixtures/adr-corpus/fixture.mjs';
const { root, revision } = buildCorpusRepo({ count: 2 });
const stateDir = tmpStateDir();
const env = { ...process.env, QQ_WORKFLOW_STATE_DIR: stateDir };
const backend = fakeBackendFactory();
const wf = createWorkflow({ root, env, adrBackendFactory: backend });
const schema = (tools, name) => tools.find((item) => item.name === name);
for (const name of ['search_adrs', 'read_adr']) {
  assert.ok(schema(WORKFLOW_TOOLS, name));
  assert.ok(schema(TOOLS, name));
  assert.deepEqual(schema(WORKFLOW_TOOLS, name).parameters.required, schema(TOOLS, name).inputSchema.required);
  const nativeProps = schema(WORKFLOW_TOOLS, name).parameters.properties;
  const { cwd: _cwd, ...mcpProps } = schema(TOOLS, name).inputSchema.properties;
  assert.deepEqual(nativeProps, mcpProps, 'native Architect and MCP input fields, types and bounds match');
}
const piTools = [];
const pi = { on() {}, registerCommand() {}, registerTool(tool) { piTools.push(tool); } };
const extension = createArchitectExtension(pi, {
  cwd: root, env, interactive: true, workflowFactory: () => wf,
});
extension.registerTools(extension.tools.map((tool) => tool.parameters));
const search = await piTools.find((tool) => tool.name === 'search_adrs').execute('call1', { query: 'topic-2', refreshIndex: true });
assert.equal(search.isError, false);
assert.equal(search.details.results[0].adrId, '0002');
assert.equal(search.details.results[0].sourceRevision, revision);
const read = await piTools.find((tool) => tool.name === 'read_adr').execute('call2', { adrId: 'ADR-0002', limit: 30 });
assert.equal(read.isError, false);
assert.equal(read.details.text.length, 30);
assert.equal(read.details.version, search.details.results[0].version);
assert.equal(read.details.complete, false);
const previousStateDir = process.env.QQ_WORKFLOW_STATE_DIR;
process.env.QQ_WORKFLOW_STATE_DIR = stateDir;
const mcpSearch = await callTool('search_adrs', { cwd: root, query: 'topic-1' }, { adrBackendFactory: backend });
assert.equal(mcpSearch.ok, true, mcpSearch.reason);
assert.equal(mcpSearch.results[0].adrId, '0001');
const mcpRead = await callTool('read_adr', { cwd: root, adrId: 'ADR-0001' });
assert.equal(mcpRead.version, mcpSearch.results[0].version);
assert.equal(mcpRead.sourceRevision, revision);
assert.ok(backend.calls.index[0].files.every((file) => file.startsWith('docs/adr/ADR-')));
if (previousStateDir === undefined) delete process.env.QQ_WORKFLOW_STATE_DIR;
else process.env.QQ_WORKFLOW_STATE_DIR = previousStateDir;
console.log('PASS real native pi/operation/MCP dispatch and schema parity, fake backend only');
