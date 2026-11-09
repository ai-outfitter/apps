import assert from 'node:assert/strict';
import {test} from 'node:test';
import {operations,scheduleInput} from '../src/workflow-host';
test('schedule bindings are explicit, bounded, and backwards compatible',()=>{
  assert.deepEqual(operations['schedule.save'].input.parse({workflow:'daily'}).connectionBindings,[]);
  const connectionBindings=[{connectionId:'first',resource:'library'},{connectionId:'second',resource:'queue'}];
  assert.deepEqual(operations['schedule.save'].input.parse({workflow:'daily',connectionBindings}).connectionBindings,connectionBindings);
  assert.equal(operations['schedule.save'].input.safeParse({workflow:'daily',connectionBindings:Array(21).fill(connectionBindings[0])}).success,false);
  assert.equal(operations['schedule.save'].input.safeParse({workflow:'daily',connectionId:'first'}).success,false);
  assert.deepEqual(scheduleInput.parse({runId:crypto.randomUUID(),scheduledFor:1,schedule:{id:'s',workflowId:'daily',inputs:{},connectionId:null,resource:null}}).schedule.connectionBindings,[]);
});
