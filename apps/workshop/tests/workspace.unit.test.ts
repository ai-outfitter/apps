import assert from 'node:assert/strict';
import test from 'node:test';
import { AssemblySchema,placements,assemblyBounds,bomTotals } from '../src/lib/assembly';
import { BuildManifestSchema } from '../src/lib/workspace';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('workspace mesh instances compose full 3D transforms and BOM quantities',()=>{
 const assembly=AssemblySchema.parse({rootId:id(1),items:[{id:id(1),number:'A',revision:'A',name:'Test fixture',kind:'assembly',uses:[{id:id(3),itemId:id(2),quantity:1,position:[10,20,30],orientation:[90,0,0]}]},{id:id(2),number:'P',revision:'A',name:'Bracket',kind:'fabricated',mesh:{path:'a'.repeat(64)+'/bracket.stl',bounds:{min:[0,0,0],max:[2,3,4]}}}]});
 const bounds=assemblyBounds(placements(assembly))!;
 assert.ok(Math.abs(bounds.min[1]-16)<1e-9);assert.ok(Math.abs(bounds.max[2]-33)<1e-9);
 assert.equal(bomTotals(assembly).lines[0].quantity,1);
 assert.equal(assembly.items[1].priceKnown,false);
});
test('workspace manifests reject missing mesh artifacts',()=>{
 const manifest={version:1,units:'mm',sourceCommit:'a'.repeat(40),sourceHash:'b'.repeat(64),compiler:'test',runner:'container:test',parameters:{},artifacts:[],tests:[],notes:'',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),assembly:{items:[{id:id(2),number:'P',revision:'A',name:'Test part',kind:'fabricated',mesh:{path:'missing.stl',bounds:{min:[0,0,0],max:[1,1,1]}}}]}};
 assert.match(BuildManifestSchema.safeParse(manifest).error?.message??'',/Missing mesh/);
});
