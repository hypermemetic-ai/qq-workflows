import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,chmodSync,writeFileSync,existsSync,symlinkSync,statSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {acquireWorkflowRelayRuntime} from '../workflow/relay-placement.mjs';
const install=process.env.QQ_RELAY_INSTALL_ROOT||join(homedir(),'.local/lib/qq/relay');
if(!existsSync(join(install,'bin/qq-relay'))){console.log('SKIP private relay placement: relay unavailable');process.exit(0);}
const root=mkdtempSync(join(tmpdir(),'qq-relay-place-'));
const unsafe=join(root,'project');mkdirSync(unsafe);chmodSync(unsafe,0o775);
const recordState=join(unsafe,'state');
const env={...process.env,QQ_RELAY_INSTALL_ROOT:install,XDG_STATE_HOME:join(root,'private')};
const first=await acquireWorkflowRelayRuntime({stateDir:recordState,env});
assert.equal(first.ok,true,first.reason);assert.ok(first.relay.socketPath.startsWith(env.XDG_STATE_HOME));
assert.equal(first.placement.recordStateDir,recordState);
const socket=first.relay.socketPath;
const second=await acquireWorkflowRelayRuntime({stateDir:recordState,env});
assert.equal(second.relay,first.relay);await second.relay.release();assert.equal((await first.relay.inspect()).service,'qq-relay');
await first.relay.release();
const third=await acquireWorkflowRelayRuntime({stateDir:recordState,env});assert.equal(third.relay.socketPath,socket);await third.relay.release();
const other=await acquireWorkflowRelayRuntime({stateDir:join(unsafe,'other'),env});assert.notEqual(other.relay.socketPath,socket);await other.relay.release();
writeFileSync(join(recordState,'relay','existing-journal'),'historical obligations');
const refused=await acquireWorkflowRelayRuntime({stateDir:recordState,env});assert.equal(refused.ok,false);assert.match(refused.reason,/existing relay artifacts preserved/);
console.log('PASS original relay on private per-record cache: writable project untouched, stable restart path, shared-holder isolation, existing journals never abandoned');

const symlinkScope=join(root,'symlink-scope');mkdirSync(symlinkScope);
const target=join(root,'unrelated');mkdirSync(target);chmodSync(target,0o755);
symlinkSync(target,join(symlinkScope,'relay'));
const unsafeLink=await acquireWorkflowRelayRuntime({stateDir:symlinkScope,env});
assert.equal(unsafeLink.ok,false);assert.equal(statSync(target).mode&0o777,0o755,'no permission mutation of unrelated symlink target');
