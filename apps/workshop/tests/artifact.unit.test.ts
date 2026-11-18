import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifiedArtifact,ArtifactPathSchema} from '../src/lib/artifact';
const data='verified mesh',hash=createHash('sha256').update(data).digest('hex'),path=hash+'/part.stl';
const artifact={path,sha256:hash,bytes:data.length},base='/files/main/builds/project/build/';
test('mesh bytes must match the saved build manifest and content address',async()=>{
 let calls=0;const fetcher=(async()=>{calls++;return new Response(data);}) as typeof fetch;
 assert.equal(new TextDecoder().decode(await verifiedArtifact(base,path,[artifact],undefined,fetcher)),data);
 await assert.rejects(verifiedArtifact('',path,[artifact],undefined,fetcher),/no saved build/);
 await assert.rejects(verifiedArtifact('https://other.example/',path,[artifact],undefined,fetcher),/no saved build/);
 await assert.rejects(verifiedArtifact(base,path,[],undefined,fetcher),/not registered/);
 assert.equal(calls,1);
 await assert.rejects(verifiedArtifact(base,path,[{...artifact,bytes:1}],undefined,fetcher),/integrity/);
 await assert.rejects(verifiedArtifact(base,path,[artifact],undefined,(async()=>new Response('tampered mesh')) as typeof fetch),/integrity/);
});
test('artifact paths reject traversal and remote URLs',()=>{
 for(const path of ['../other.stl','/absolute.stl','https://other.example/mesh','hash/../part.stl'])assert.equal(ArtifactPathSchema.safeParse(path).success,false);
});
