// Reusable installed-Pi fixture: only localhost model traffic, private config,
// recording and state. No operator provider registry or credential is read.
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,statSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {processFingerprint} from '../../workflow/jobs.mjs';
export async function localPiProvider({respond}={}) {
  const pi=String(process.env.PATH??'').split(':').map(p=>join(p,'pi')).find(p=>{try{return existsSync(p)&&statSync(p).isFile();}catch{return false;}});
  if(!pi)return null;
  const root=mkdtempSync(join(tmpdir(),'qq-local-pi-'));
  const agentDir=join(root,'agent');mkdirSync(agentDir);
  mkdirSync(join(root,'state'),{mode:0o700}); // real relay requires a private transport ancestry
  const configFile=join(root,'worker-config.json');
  const provider='local-fixture'; const model='local-fixture-model';
  let calls=0;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url.includes('/chat/completions')){res.writeHead(404);res.end();return;}
    const body=JSON.parse(raw);const call=++calls;
    try {
      const answer=await respond({body,call});
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      const event=(delta,finish_reason=null)=>({id:`fixture-${call}`,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model,choices:[{index:0,delta,finish_reason}]});
      res.write(`data: ${JSON.stringify(event({role:'assistant',...(answer.toolCalls?.length?{content:null,tool_calls:answer.toolCalls.map((tool,index)=>({index,id:tool.id??`call-${call}-${index}`,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.arguments??{})}}))}:{content:answer.text??'fixture result'})}))}\n\n`);
      res.write(`data: ${JSON.stringify(event({},answer.toolCalls?.length?'tool_calls':'stop'))}\n\ndata: [DONE]\n\n`);res.end();
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:{message:error.message}}));}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  writeFileSync(join(agentDir,'models.json'),JSON.stringify({providers:{[provider]:{api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'localhost-dummy',models:[{id:model,name:model,reasoning:true,input:['text'],contextWindow:200000,maxTokens:8192,thinkingLevelMap:{off:null,minimal:'minimal',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:null},compat:{supportsReasoningEffort:true,maxTokensField:'max_tokens',supportsStrictMode:false}}]}}}));
  writeFileSync(configFile,JSON.stringify({harness:'pi',provider,model,reasoning_effort:'high',context:{enabled:true,reserve_tokens:8192,keep_recent_tokens:2000}}));
  const env={...process.env,QQ_WORKER_CONFIG_FILE:configFile,QQ_WORKER_PI_BIN:pi,QQ_WORKER_PI_AGENT_DIR:agentDir,PI_CODING_AGENT_DIR:agentDir,XDG_STATE_HOME:join(root,'xdg'),QQ_WORKFLOW_STATE_DIR:join(root,'state'),PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0'};
  for(const key of Object.keys(env))if(key.startsWith('QQ_RUNNER_')||key.startsWith('QQ_ARCHITECT_')||key.startsWith('QQ_ZVEC_GREP_'))delete env[key];
  delete env.QQ_WORKFLOW_COMMUNICATION;delete env.QQ_WORKER_SESSION_DIR;
  return {root,env,pi,provider,model,get calls(){return calls;},stop:async()=>{
    server.closeAllConnections();await new Promise(done=>server.close(done));
    // A coordinator SIGKILL deliberately leaves an orphan relay. Reap only
    // relay processes whose exact state-dir argument belongs to this fixture;
    // never stop a shared production runtime or another fixture's relay.
    for(const entry of readdirSync('/proc')) {
      if(!/^\d+$/.test(entry))continue;
      const pid=Number(entry);let argv;
      try{argv=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');}catch{continue;}
      const index=argv.indexOf('--state-dir');
      if(!basename(argv[0]??'').includes('qq-relay')||index<0||!argv[index+1]?.startsWith(root+'/'))continue;
      const expected=processFingerprint({pid});if(!expected)continue;
      try{process.kill(pid,'SIGTERM');}catch{continue;}
      await new Promise(done=>setTimeout(done,100));
      const observed=processFingerprint({pid});
      if(observed&&observed.startTicks===expected.startTicks&&observed.cmdlineHash===expected.cmdlineHash)try{process.kill(pid,'SIGKILL');}catch{}
    }
  }};
}
