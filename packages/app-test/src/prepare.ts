import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
function context(directory:URL|string) {
 const app=resolve(directory instanceof URL?fileURLToPath(directory):directory);
 const modes=Object.keys(JSON.parse(readFileSync(join(app,'app.json'),'utf8')).modes);
 return {app,modes};
}
/** App-owned package outputs; no platform generated modules are imported. */
export function appArtifact(directory:URL|string,mode:'demo'|'operational') {
 const {app,modes}=context(directory);
 if(!modes.includes(mode)) throw Error(`Undeclared app mode: ${mode}`);
 return pathToFileURL(join(app,'.outfitter/packages',`${mode}.json`));
}
/** Run the app's declared portable build before integration or browser tests. */
export function prepareAppTests(directory:URL|string) {
 const {app}=context(directory);
 const result=spawnSync('npm',['run','build'],{cwd:app,stdio:'inherit'});
 if(result.error) throw result.error;
 if(result.status!==0) throw Error('App test preparation failed');
}
