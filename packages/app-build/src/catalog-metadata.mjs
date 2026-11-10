import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,extname} from 'node:path';
export const catalogContractModule='__outfitter_catalog_contract.mjs';
export const catalogContract = metadata => `export default ${JSON.stringify(createHash('sha256').update(JSON.stringify(metadata)).digest('hex'))};\n`;
export async function catalogMetadata(directory,app) {
  const metadata={};
  for(const [key,path,parse] of [
    ['graph','graph/schema.graphql',value=>value],
    ['documents','graph/documents.json',JSON.parse],
    ['views','graph/wiki-views.json',JSON.parse],
    ['viewerFields','graph/viewer-fields.json',JSON.parse],
    ['previewPolicy','scripts/preview.mjs',value=>value],
  ]) {
    try { metadata[key]=parse(await readFile(join(directory,path),'utf8')); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  if(app.catalog?.cover) {
    assert.match(app.catalog.cover,/^catalog\/[a-zA-Z0-9_-]+\.(?:png|webp|jpg|jpeg|svg)$/);
    const contentType={'.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml'}[extname(app.catalog.cover)];
    metadata.cover={data:(await readFile(join(directory,app.catalog.cover))).toString('base64'),contentType};
  }
  return metadata;
}
