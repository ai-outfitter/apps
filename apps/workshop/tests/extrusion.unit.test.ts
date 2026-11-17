import assert from 'node:assert/strict';
import test from 'node:test';
import { AssemblyCadPlanSchema, CadPlanSchema, planBounds } from '../src/model/cad-plan';
import { ItemSchema } from '../src/lib/assembly';

// Tier 4: the Artera team needs supplier rail contact profiles, including recesses.
const profile: [number,number][]=[[0,0],[10,0],[10,2],[4,2],[4,1],[0,1]];
const feature=(axis:'x'|'y'|'z')=>({kind:'extrusion' as const,mode:'add' as const,base:[10,20,30] as [number,number,number],height:100,axis,points:profile});
const plan=(f:unknown)=>({version:1,units:'mm',features:[f]});

test('profile planes follow right-handed axis mapping and preserve nonzero origins',()=>{
 for(const [axis,max] of [['x',[110,30,32]],['y',[12,120,40]],['z',[20,22,130]]] as const){
  const p=AssemblyCadPlanSchema.parse(plan(feature(axis)));
  assert.deepEqual(planBounds(p),{min:[10,20,30],max,size:max.map((v,i)=>v-[10,20,30][i])});
 }
});

test('profile schema rejects degenerate, crossing and unbounded polygons',()=>{
 for(const points of [[],[[0,0],[1,1],[2,2]],[[0,0],[4,0],[0,3],[3,3]],[[0,0],[1,0],[1,0],[0,1]],[[0,0],[4,0],[2,0],[2,2],[0,2]],[[0,0],[6000,0],[0,1]]])
  assert.equal(AssemblyCadPlanSchema.safeParse(plan({...feature('x'),points})).success,false);
 assert.equal(CadPlanSchema.safeParse(plan({...feature('x'),height:1434})).success,false);
 assert.equal(AssemblyCadPlanSchema.safeParse(plan({...feature('x'),height:1434})).success,true);
 assert.equal(AssemblyCadPlanSchema.safeParse(plan({...feature('x'),points:[...profile].reverse()})).success,true);
});

test('saved COTS items accept a long profile while single-part designs stay bounded',()=>{
 const geometry=plan({...feature('x'),height:1434});
 assert.equal(CadPlanSchema.safeParse(geometry).success,false);
 assert.equal(ItemSchema.safeParse({id:'f7806e7b-190d-47d0-aa96-1bc123e6a259',number:'WS-10-40',revision:'A',name:'Artera supplier rail',kind:'cots',geometry}).success,true);
});
