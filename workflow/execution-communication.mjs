// Transport glue for managed roles. All assignment and outcome authority stays
// in execution-authority/change-record; the consumer and relay are the shared
// runner lifecycle runtime, not another orchestrator.
import {readJob} from './jobs.mjs';
import {acquireWorkflowRelayRuntime} from './relay-placement.mjs';
import {COMMUNICATION_BINDING_ENV,COMMUNICATION_BINDING_SCHEMA,validateCommunicationBinding,resolveRelayInstall} from './communication.mjs';
import {DEFAULT_RUNTIME_ACTOR,readLaunchMetadata,steerRoleAttempt} from './execution-authority.mjs';

export async function prepareManagedRoleCommunication({stateDir,executionId,jobId,attemptId,role,env=process.env}) {
  const meta=readLaunchMetadata({stateDir,executionId});
  const owner=meta.owner,root=meta.launch.root;
  const {acquireRunnerConsumer,retryPendingRunnerAmendments}=await import('./runner-lifecycle.mjs');
  const consumer=await acquireRunnerConsumer({stateDir,root,ownerRouting:owner,env,
    workflowRouting:{root,sessionKey:owner,sessionId:owner,ownerAgentId:owner},
    // The host hands responsibility to the durable notification journal. The
    // owning Architect's ordinary readiness/recovery path performs delivery.
    transport:{name:'execution-host-handoff',deliver:async()=>({state:'queued',reason:'awaiting owning coordinator readiness'})},
    ownsChange:({changeId})=>readJob(stateDir,changeId)?.workflow?.sessionKey===owner,
  });
  if(!consumer.ok)throw new Error(`managed role communication unavailable: ${consumer.reason}`);
  let timer=null,active=true,retrying=false;
  const release=async()=>{if(!active)return;active=false;clearInterval(timer);await consumer.release();};
  try {
    const install=resolveRelayInstall(env);
    const binding=validateCommunicationBinding({schema:COMMUNICATION_BINDING_SCHEMA,stateDir,changeId:executionId,
      jobId,attemptId,actorId:`worker-${attemptId}`,runtimeActorId:DEFAULT_RUNTIME_ACTOR,role,
      recipientAgent:`agents/${consumer.consumerId}`,socketPath:consumer.relay.socketPath,
      ...(install.root?{installRoot:install.root}:{})});
    const retry=async()=>{
      if(!active||retrying)return;retrying=true;
      try{await retryPendingRunnerAmendments({stateDir,changeId:executionId,jobId,relay:consumer.relay,actor:{kind:'runtime',id:DEFAULT_RUNTIME_ACTOR}});}
      catch{/* the authoritative pending obligation remains retrievable */}
      finally{retrying=false;}
    };
    timer=setInterval(()=>void retry(),1000);timer.unref?.();
    return {bindingEnv:{[COMMUNICATION_BINDING_ENV]:JSON.stringify(binding)},release};
  } catch(error) {await release();throw error;}
}

export async function steerManagedRoleCommunication({env=process.env,...args}) {
  // Failure to acquire transport does not discard an admitted amendment. The
  // shared submission path reports its recorded/unavailable state truthfully.
  const acquired=await acquireWorkflowRelayRuntime({stateDir:args.stateDir,env});
  try{return await steerRoleAttempt({...args,relay:acquired.ok?acquired.relay:null});}
  finally{if(acquired.ok)await acquired.relay.release();}
}
