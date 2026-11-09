import assert from 'node:assert/strict';
import {test} from 'node:test';
import {packagedGraphMetadata} from '../src/app-graph-metadata';
const sample={schema:'type Query { title: String }',documents:[{name:'ReadTitle',story:'As an owner, I want to read a title, so that I can inspect my records.',query:'query ReadTitle { title }',hash:'untrusted',variables:{unexpected:true},mcp:{description:'Read an owned title.'}}]};
test('packaged documents derive execution metadata and retain explicit publication',()=>{
  const graph=packagedGraphMetadata(sample);
  assert.match(graph.documents[0].hash,/^[a-f0-9]{64}$/);
  assert.deepEqual(graph.documents[0].variables,{type:'object',properties:{},required:[]});
  assert.equal(graph.documents[0].mcp?.description,'Read an owned title.');
});
test('invalid schemas, documents, root names and duplicate names cannot enter a package',()=>{
  for(const value of [{schema:'type Query { __reserved: String }',documents:[]},{schema:'schema { query: Root } type Root { title: String }',documents:[]},{...sample,documents:[{...sample.documents[0],query:'query ReadTitle { secret }'}]},{...sample,documents:[sample.documents[0],sample.documents[0]]}])assert.throws(()=>packagedGraphMetadata(value));
});
