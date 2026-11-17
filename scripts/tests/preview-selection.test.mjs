import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('previews skip apps selected only through a shared package or lockfile change',async t=>{
 const source=await readFile(new URL('../../.github/workflows/preview.yml',import.meta.url),'utf8');
 const script=source.match(/- id: direct[\s\S]+?<<'NODE'\n([\s\S]+?)          NODE/)[1].replace(/^          /gm,'');
 const root=await mkdtemp(join(tmpdir(),'preview-selection-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','ci@example.com');git('config','user.name','ci');
 for(const dir of ['apps/planning','apps/wiki','packages/app-sdk']) await mkdir(join(root,dir),{recursive:true});
 await writeFile(join(root,'package-lock.json'),'{}');await writeFile(join(root,'apps/planning/a.ts'),'');await writeFile(join(root,'apps/wiki/a.ts'),'');
 git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
 await writeFile(join(root,'package-lock.json'),'{"x":1}');await writeFile(join(root,'packages/app-sdk/a.ts'),'');await writeFile(join(root,'apps/planning/a.ts'),'x');
 git('add','.');git('commit','-qm','head');const head=git('rev-parse','HEAD');
 const output=join(root,'out');
 execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env:{...process.env,SELECTED_APPS:'["apps/planning","apps/wiki"]',BASE_SHA:base,HEAD_SHA:head,GITHUB_OUTPUT:output}});
 assert.equal(await readFile(output,'utf8'),'apps=["apps/planning"]\nhas_apps=true\n');
});
