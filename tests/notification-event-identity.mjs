import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createJob,readJob,writeJob,recordTerminal,deliveryPending} from '../workflow/jobs.mjs';
import {routeNotification,acknowledgeDelivery,recoverPendingDeliveries,readNotification,completedEventId} from '../workflow/notify.mjs';
const stateDir=mkdtempSync(join(tmpdir(),'qq-event-identity-'));
const workflow={sessionKey:'owner',root:stateDir};
for(const stale of [false,true]) {
 const id=stale?'legacy-pollution':'new-progress';
 createJob({stateDir,id,role:'runner',workflow,cwd:stateDir});
 const eventId=`runner:${id}:progress:change:attempt:7`;
 await routeNotification({stateDir,eventId,jobId:id,role:'runner',workflow,text:'progress only',transport:{name:'fixture',deliver:async()=>({state:'queued'})}});
 acknowledgeDelivery({stateDir,eventId,jobId:id,receipt:{kind:'pi-session-entry',entryId:'progress-entry'}});
 assert.equal(readNotification(stateDir,eventId).state,'delivered');
 assert.equal(readJob(stateDir,id).delivery,null,'progress receipt must not occupy completion slot');
 if(stale)writeJob(stateDir,{...readJob(stateDir,id),delivery:{eventId,state:'delivered',receipt:{kind:'pi-session-entry'}}});
 recordTerminal(stateDir,id,{status:'completed',summary:'completed findings'});
 assert.equal(deliveryPending(stateDir,id),true,'progress receipt cannot satisfy completion');
 const delivered=[];const transport={name:'fixture',deliver:async note=>{delivered.push(note);return {state:'delivered',receipt:{kind:'fixture',confirmed:true}};}};
 await recoverPendingDeliveries({stateDir,sessionKey:'owner',transport});
 assert.equal(delivered.length,1);assert.equal(delivered[0].eventId,completedEventId(readJob(stateDir,id)));
 assert.equal(readJob(stateDir,id).delivery.eventId,delivered[0].eventId);
 acknowledgeDelivery({stateDir,eventId,jobId:id,receipt:{kind:'pi-session-entry',entryId:'late-progress-entry'}});
 assert.equal(readJob(stateDir,id).delivery.eventId,delivered[0].eventId,'late progress receipt preserves terminal receipt');
 await recoverPendingDeliveries({stateDir,sessionKey:'owner',transport});assert.equal(delivered.length,1);
 assert.equal(readNotification(stateDir,eventId).state,'delivered','original progress evidence retained');
}
console.log('PASS progress receipt cannot suppress terminal wake; stale polluted projection repairs without duplicate completion or lost progress evidence');
