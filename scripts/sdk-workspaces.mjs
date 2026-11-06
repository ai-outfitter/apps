// Restrict SDK validation to SDK packages, not official app workspaces.
import {readdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const command=process.argv[2];
if(!['check','test','build'].includes(command)) throw Error('Expected check, test or build');
const packages=readdirSync('packages',{withFileTypes:true}).filter(e=>e.isDirectory() && existsSync(join('packages',e.name,'package.json'))).map(e=>join('packages',e.name));
const result=spawnSync('npm',['run',command,...packages.flatMap(path=>['--workspace',path]),'--if-present'],{stdio:'inherit'});
if(result.error) throw result.error;
process.exitCode=result.status ?? 1;
