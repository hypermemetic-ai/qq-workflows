// The authoritative record remains in stateDirFor(root, env). Relay files are
// a subordinate transport cache and may need a safer location: ordinary 0775
// project directories fail the original relay's entire-ancestor-chain fence.
// Existing journals are NEVER relocated, replaced, or silently abandoned.
import {createHash} from 'node:crypto';
import {existsSync,readdirSync,mkdirSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,isAbsolute,resolve} from 'node:path';
import {acquireRelayRuntime,relayRuntimeDir} from './communication.mjs';
export async function acquireWorkflowRelayRuntime({stateDir,env=process.env,...options}) {
  const original=relayRuntimeDir(stateDir);
  const result=await acquireRelayRuntime({stateDir,env,...options});
  if(result.ok || result.code!=='refused' || !/group\/other-writable/.test(result.reason??''))return result;
  // A cache with existing obligations is not eligible for implicit relocation.
  if(existsSync(original)&&readdirSync(original).length) return {...result,reason:result.reason+'; existing relay artifacts preserved, explicit relocation required'};
  const stateHome=env.XDG_STATE_HOME || join(env.HOME || homedir(),'.local','state');
  if(!isAbsolute(stateHome))return {ok:false,code:'refused',reason:'private relay state home must be absolute'};
  const key=createHash('sha256').update(resolve(stateDir)).digest('hex').slice(0,24);
  const transportScope=join(stateHome,'qq-workflows','relays',key);
  mkdirSync(transportScope,{recursive:true,mode:0o700});
  const info=lstatSync(transportScope);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777)!==0o700||info.uid!==process.getuid())return {ok:false,code:'refused',reason:'private relay scope is not an owned 0700 directory'};
  const originFile=join(transportScope,'record-origin.json');
  try {writeFileSync(originFile,JSON.stringify({schema:1,stateDir:resolve(stateDir)}),{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;}
  let recorded;
  try{recorded=JSON.parse(readFileSync(originFile,'utf8'));}catch{return {ok:false,code:'refused',reason:'private relay origin is unreadable'};}
  if(recorded.schema!==1||recorded.stateDir!==resolve(stateDir))return {ok:false,code:'refused',reason:'private relay origin mismatch'};
  const relocated=await acquireRelayRuntime({stateDir:transportScope,env,...options});
  return {...relocated,placement:{recordStateDir:stateDir,transportScope,reason:'repository directory chain is writable; transport only'}};
}
