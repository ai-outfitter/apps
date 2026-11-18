import assert from 'node:assert/strict';
import test from 'node:test';
import { modelCatalog, modelView } from '../src/lib/model-catalog';
import { placements } from '../src/lib/assembly';
import { sensorNodeAssembly } from '../src/lib/sensor-node';

test('researcher browsing SNY-1 sees distinct parts, repeated quantities and unplaced definitions', () => {
 const assembly = sensorNodeAssembly();
 const screw = assembly.items.find(item => item.number === 'SNY-C008')!;
 const spare = {...screw, id:crypto.randomUUID(), number:'SPARE', name:'Unplaced spare'};
 assembly.items.push(spare);
 const rows=modelCatalog(assembly);
 assert.equal(rows.length,assembly.items.length);
 assert.equal(rows.find(row=>row.item.id===screw.id)?.quantity,4);
 assert.equal(rows.find(row=>row.item.id===spare.id)?.quantity,0);
 assert.equal(modelCatalog(assembly,'SPARE','unmodeled').length,1);
 assert.equal(modelCatalog(assembly,'esp32','cots').length,1);
 assert.ok(modelCatalog(assembly,'','assembly').every(row=>row.modeled));
});

test('a part or subassembly opens in its own coordinates without changing the saved assembly', () => {
 const assembly=sensorNodeAssembly(), before=JSON.stringify(assembly);
 const part=assembly.items.find(item=>item.number==='SNY-C001')!;
 const placed=placements(modelView(assembly,part.id));
 assert.equal(placed.length,1);
 assert.equal(placed[0].item.id,part.id);
 assert.deepEqual(placed[0].position,[0,0,0]);
 const sub=assembly.items.find(item=>item.number==='SNY-A002')!;
 assert.ok(placements(modelView(assembly,sub.id)).length>1);
 assert.equal(modelView(assembly,'missing'),assembly);
 assert.equal(JSON.stringify(assembly),before);
});

test('assembly navigation shows immediate children and aggregates repeated placements', async () => {
 const {assemblyChildren,assemblyPath}=await import('../src/lib/model-catalog');
 const assembly=sensorNodeAssembly(), before=JSON.stringify(assembly);
 const root=assembly.items.find(i=>i.id===assembly.rootId)!;
 const child=assembly.items.find(i=>i.id===root.uses[0].itemId)!;
 root.uses.push({...root.uses[0],id:crypto.randomUUID(),quantity:2,refdes:'Second placement'});
 const rows=assemblyChildren(assembly);
 assert.equal(rows.find(row=>row.item.id===child.id)?.quantity,root.uses[0].quantity+2);
 assert.equal(rows.length,new Set(root.uses.map(u=>u.itemId)).size);
 const leaf=assembly.items.find(i=>i.number==='SNY-C001')!;
 const path=assemblyPath(assembly,leaf.id);
 assert.equal(path[0].id,root.id);assert.equal(path.at(-1)?.id,leaf.id);
 for(let i=1;i<path.length;i++)assert.ok(path[i-1].uses.some(u=>u.itemId===path[i].id));
 assert.deepEqual(assemblyChildren(assembly,leaf.id),[]);
 assert.deepEqual(assemblyPath(assembly,'missing'),[]);
 root.uses.pop();assert.equal(JSON.stringify(assembly),before);
});

test('a canvas pick belongs to the installed module occurrence until its model is opened', () => {
 const assembly=sensorNodeAssembly();
 const root=assembly.items.find(item=>item.id===assembly.rootId)!;
 const use=root.uses.find(u=>assembly.items.find(i=>i.id===u.itemId)?.kind==='assembly')!;
 const module=assembly.items.find(i=>i.id===use.itemId)!;
 module.selectAsUnit=true;
 use.quantity=2;
 const installed=placements(assembly).filter(p=>p.pickGroup?.id===module.id);
 assert.deepEqual(new Set(installed.map(p=>p.pickGroup?.path)),new Set([
   root.id+'/'+use.id+'#0',root.id+'/'+use.id+'#1'
 ]));
 const opened=placements(modelView(assembly,module.id));
 assert.ok(opened.length);
 assert.ok(opened.every(p=>!p.pickGroup));
});
