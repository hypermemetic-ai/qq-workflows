import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorktree,hasImplementationChanges,landWorktree} from '../workflow/git.mjs';
const root=mkdtempSync(join(tmpdir(),'qq-fresh-base-'));
const producer=join(root,'producer'),remote=join(root,'remote.git'),checkout=join(root,'checkout');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const previous=process.env.ARCHITECT_WORKTREES_DIR;
const priorPath=process.env.PATH;
const fakeBin=join(root,'bin');mkdirSync(fakeBin);
// A regression may reach the PR path: never invoke the operator's gh binary.
writeFileSync(join(fakeBin,'gh'),`#!/bin/sh\nprintf 'gh-invoked\\n' >> '${join(root,'gh-invocations')}'\nexit 99\n`,{mode:0o755});
process.env.PATH=`${fakeBin}:${priorPath}`;
process.env.ARCHITECT_WORKTREES_DIR=join(root,'worktrees');
const ticket=id=>{mkdirSync(join(checkout,'.architect','tickets'),{recursive:true});writeFileSync(join(checkout,'.architect','tickets',id+'.md'),'Approved isolated phase '+id)};
try {
  git(root,'init','--bare','--initial-branch=main',remote);
  git(root,'init','--initial-branch=main',producer);git(producer,'config','user.name','Fixture');git(producer,'config','user.email','fixture@example.invalid');
  writeFileSync(join(producer,'base.txt'),'old base\n');git(producer,'add','.');git(producer,'commit','-m','initial');git(producer,'remote','add','origin',remote);git(producer,'push','-u','origin','main');
  git(root,'clone',remote,checkout);git(checkout,'config','user.name','Fixture');git(checkout,'config','user.email','fixture@example.invalid');
  const old=git(checkout,'rev-parse','HEAD');
  writeFileSync(join(checkout,'base.txt'),'stashed work\n');git(checkout,'stash','push','-m','preserve fixture stash');const stash=git(checkout,'rev-parse','refs/stash');
  writeFileSync(join(checkout,'base.txt'),'unrelated dirty root work\n');writeFileSync(join(checkout,'untracked.txt'),'keep me\n');
  writeFileSync(join(producer,'upstream.txt'),'new upstream code\n');git(producer,'add','.');git(producer,'commit','-m','advance remote');git(producer,'push');
  const fresh=git(producer,'rev-parse','HEAD');assert.equal(git(checkout,'rev-parse','origin/main'),old,'fixture has genuinely stale remote tracking ref');
  ticket('clean-phase');const clean=await createWorktree(checkout,{kind:'open',sessionId:'clean-phase'});
  assert.equal(clean.baseSelection.sha,fresh);
  assert.equal(await hasImplementationChanges(clean.cwd,clean.branch),false,'upstream commits preceding the pinned worktree base are not implementation changes');
  const noChange=await landWorktree(checkout,{worktree:clean.cwd,branch:clean.branch,expectedBase:clean.baseSelection});
  assert.equal(noChange.method,'none','clean worktree at fetched base must retire without publication or gh');
  assert.throws(()=>readFileSync(join(root,'gh-invocations')),'no gh invocation on no-change landing');
  assert.equal(git(root,'--git-dir',remote,'rev-parse','refs/heads/main'),fresh);
  assert.throws(()=>git(root,'--git-dir',remote,'rev-parse','--verify',`refs/heads/${clean.branch}`),'no remote branch published');
  ticket('new-phase');const created=await createWorktree(checkout,{kind:'open',sessionId:'new-phase'});
  assert.equal(git(created.cwd,'rev-parse','HEAD'),fresh,'new phase must fetch and pin the actual remote default');
  assert.deepEqual(created.baseSelection,{ref:'origin/main',sha:fresh,source:'fetched-remote-default'});
  assert.equal(readFileSync(join(created.cwd,'upstream.txt'),'utf8'),'new upstream code\n');
  const pinRef=`refs/qq-workflow/bases/${created.branch}`;
  git(created.cwd,'update-ref','-d',pinRef);
  await assert.rejects(hasImplementationChanges(created.cwd,created.branch,created.baseSelection),/provenance|base pin/i,'missing creation pin cannot classify managed work');
  await assert.rejects(landWorktree(checkout,{worktree:created.cwd,branch:created.branch,expectedBase:created.baseSelection}),/provenance|base pin/i,'missing pin cannot retire a no-op');
  assert.equal(git(created.cwd,'branch','--show-current'),created.branch);
  git(created.cwd,'update-ref',pinRef,fresh);
  const wrongBase={...created.baseSelection,sha:old};
  await assert.rejects(hasImplementationChanges(created.cwd,created.branch,wrongBase),/provenance|base pin/i,'mismatched recorded pin cannot classify work');
  await assert.rejects(landWorktree(checkout,{worktree:created.cwd,branch:created.branch,expectedBase:wrongBase}),/provenance|base pin/i,'mismatched recorded base cannot retire or publish');
  assert.equal(git(created.cwd,'rev-parse','HEAD'),fresh);
  assert.throws(()=>readFileSync(join(root,'gh-invocations')),'invalid base must not invoke gh');
  // The capture seam occurs after the first identity read. Change the branch
  // while landing inspects it: neither the stale no-op nor publication is safe.
  await assert.rejects(landWorktree(checkout,{worktree:created.cwd,branch:created.branch,expectedBase:created.baseSelection,
    curation:{capture:async()=>{git(created.cwd,'switch','-c','fixture-moved');}}}),/identity|branch/i);
  assert.equal(git(created.cwd,'branch','--show-current'),'fixture-moved');
  git(created.cwd,'switch',created.branch);
  // Move HEAD during inspection too, preserving a genuine new commit beyond
  // the original pin instead of retiring the worktree as an empty change.
  await assert.rejects(landWorktree(checkout,{worktree:created.cwd,branch:created.branch,expectedBase:created.baseSelection,
    curation:{capture:async()=>{git(created.cwd,'commit','--allow-empty','-m','concurrent phase commit');}}}),/identity|head|changed/i);
  assert.notEqual(git(created.cwd,'rev-parse','HEAD'),fresh);
  assert.equal(await hasImplementationChanges(created.cwd,created.branch,created.baseSelection),true);
  assert.throws(()=>readFileSync(join(root,'gh-invocations')),'moving branch or HEAD must not invoke gh');
  await assert.rejects(landWorktree(checkout,{worktree:created.cwd,branch:'architect/open/not-the-current-branch'}),
    'a mismatched requested branch cannot retire or publish the actual worktree');
  assert.equal(git(created.cwd,'branch','--show-current'),created.branch);
  assert.throws(()=>readFileSync(join(root,'gh-invocations')),'mismatched branch does not call gh');
  assert.equal(git(checkout,'rev-parse','HEAD'),old,'stale root checkout is untouched');
  assert.equal(readFileSync(join(checkout,'base.txt'),'utf8'),'unrelated dirty root work\n');
  assert.equal(readFileSync(join(checkout,'untracked.txt'),'utf8'),'keep me\n');assert.equal(git(checkout,'rev-parse','refs/stash'),stash);
  writeFileSync(join(created.cwd,'base.txt'),'unfinished preserved phase\n');writeFileSync(join(created.cwd,'pending.txt'),'unfinished new file\n');
  ticket('pinned-phase');const pinned=await createWorktree(checkout,{kind:'open',sessionId:'pinned-phase',base:old});assert.equal(git(pinned.cwd,'rev-parse','HEAD'),old,'explicit approved base is preserved');
  git(checkout,'remote','set-url','origin',join(root,'unavailable.git'));
  const reused=await createWorktree(checkout,{kind:'open',sessionId:'new-phase'});assert.equal(reused.reused,true,'existing phase does not depend on remote availability');
  assert.equal(reused.baseSelection.sha,fresh,'reuse retains original base even when remote is unavailable');
  assert.equal(await hasImplementationChanges(reused.cwd,reused.branch),true,'eligible dirty files beyond the pin remain detectable');
  assert.equal(readFileSync(join(reused.cwd,'base.txt'),'utf8'),'unfinished preserved phase\n');assert.equal(readFileSync(join(reused.cwd,'pending.txt'),'utf8'),'unfinished new file\n');
  ticket('committed-phase');const committed=await createWorktree(checkout,{kind:'open',sessionId:'committed-phase',base:old});
  writeFileSync(join(committed.cwd,'own-change.txt'),'genuine commit\n');git(committed.cwd,'add','own-change.txt');git(committed.cwd,'commit','-m','work beyond original base');
  const committedHead=git(committed.cwd,'rev-parse','HEAD');
  const committedReuse=await createWorktree(checkout,{kind:'open',sessionId:'committed-phase'});
  assert.equal(committedReuse.baseSelection.sha,old,'reuse cannot replace original pin with current HEAD');
  assert.equal(git(committedReuse.cwd,'rev-parse','HEAD'),committedHead,'reuse cannot reset legitimate commits');
  assert.equal(await hasImplementationChanges(committedReuse.cwd,committedReuse.branch),true,'committed changes beyond original pin remain detectable');
  ticket('must-refuse');await assert.rejects(createWorktree(checkout,{kind:'open',sessionId:'must-refuse'}));
  assert.throws(()=>git(checkout,'rev-parse','--verify','refs/heads/architect/open/mustrefu'),'failed verification creates no phase branch');
  assert.equal(git(checkout,'rev-parse','HEAD'),old);assert.equal(git(checkout,'rev-parse','refs/stash'),stash);
  console.log('PASS actual Git: stale local base cannot invent implementation changes or publish a branch; original pin survives reuse; eligible work is retained');
}finally{
  if(previous===undefined)delete process.env.ARCHITECT_WORKTREES_DIR;else process.env.ARCHITECT_WORKTREES_DIR=previous;
  process.env.PATH=priorPath;
  rmSync(root,{recursive:true,force:true});
}
