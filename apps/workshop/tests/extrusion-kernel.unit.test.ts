import assert from 'node:assert/strict';
import test from 'node:test';
import opencascade from 'replicad-opencascadejs';
import {setOC} from 'replicad';
import {AssemblyCadPlanSchema} from '../src/model/cad-plan';
import {buildPlannedModel} from '../src/model/geometry';

// Tier 4 Artera rail: a concave contact profile and a through-hole must survive all axis mappings.
test('profile extrusion builds concave solids and correct through-bores on every axis',async()=>{
 setOC(await opencascade());
 const points=[[0,0],[10,0],[10,2],[4,2],[4,1],[0,1]];
 for(const [index,axis] of ['x','y','z'].entries()) {
  const base=[10,20,30],hole=[...base];hole[(index+1)%3]+=6;hole[(index+2)%3]+=1;
  const plan=AssemblyCadPlanSchema.parse({version:1,units:'mm',features:[
   {kind:'extrusion',mode:'add',base,axis,height:100,points},
   {kind:'cylinder',mode:'cut',base:hole,axis,height:100,radius:.25},
  ]});
  const model=buildPlannedModel(plan);
  try {
   assert.ok(Math.abs(model.volume-(16-Math.PI*.25**2)*100)<1e-5,`${axis}: ${model.volume}`);
   const max=[...base];max[index]+=100;max[(index+1)%3]+=10;max[(index+2)%3]+=2;
   const bounds=model.solid.boundingBox.bounds;
   for(const [side,expected] of [[0,base],[1,max]] as const)
    expected.forEach((v,i)=>assert.ok(Math.abs(bounds[side][i]-v)<1e-5));
  } finally {model.solid.delete();}
 }
});
