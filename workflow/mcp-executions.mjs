// MCP adapts the same managed execution operations/owned host as native Pi.
// This map caches workflow handles only; jobs, reports, amendments and recovery
// are reconstructed from the shared durable state after an MCP restart.
import {createWorkflow} from './operations.mjs';
import {launchExecutionHost} from './execution-supervisor.mjs';

export function createMcpExecutionSurface({resolveContext,notify,env=process.env}) {
  const workflows=new Map();
  async function context(args={}) {
    const {root,owner}=await resolveContext(args);
    const key=JSON.stringify([root,owner]);
    if(!workflows.has(key)) {
      const transport={name:'mcp-coordinator-queue',deliver:async notification=>{
        const role=notification.role==='runner'?'runner':'execution';
        const kind=role+(notification.eventId.includes(':progress:')?'.progress':'.terminal');
        const result=await notify(owner,notification.text,{kind,trackerId:notification.jobId});
        return {state:result?.notified?'accepted':'failed',reason:result?.reason??null,via:result?.via??null,threadId:result?.threadId??null};
      }};
      workflows.set(key,createWorkflow({root,sessionKey:owner,env,notifierTransport:transport,
        executionLauncher:args=>launchExecutionHost({stateDir:args.stateDir,jobId:args.jobId,root,
          owner,kind:args.kind,phaseId:args.phaseId,baseRef:args.baseRef,env,onPhase:args.onPhase})}));
    }
    return workflows.get(key);
  }
  return {
    async dispatch(args={}) {
      const wf=await context(args);
      const result=wf.dispatchExecution({kind:args.kind,phaseId:args.phaseId,baseRef:args.baseRef});
      return {...result,id:result.jobId,cwd:wf.root};
    },
    async check(args={}) {
      const wf=await context(args),id=args.id??args.jobId;
      const result=wf.checkExecution({jobId:id});
      return {...result,id,reportId:result.terminal?.reportId??result.reportId??null};
    },
    async steer(args={}) {
      return (await context(args)).steerExecution({jobId:args.id??args.jobId,message:args.message,expectAttemptId:args.expectAttemptId,expectJobId:args.expectJobId});
    },
    async cancel(args={}) {
      return (await context(args)).cancelExecution({jobId:args.id??args.jobId,reason:args.reason});
    },
    async readReport(args={}) {
      return (await context(args)).readReport({reportId:args.reportId,offset:args.offset,limit:args.limit});
    },
    async recover() {
      // Bootstrap the current repository/owner even before the first tool call.
      // Missing runtime identity is explicit on tools and leaves recovery idle.
      try {await context();} catch {}
      const results=[];
      for(const wf of workflows.values()) {
        try {results.push(await wf.recoverDeliveries());}
        catch(error){results.push({ok:false,error:String(error?.message??error)});}
      }
      return results;
    },
  };
}
