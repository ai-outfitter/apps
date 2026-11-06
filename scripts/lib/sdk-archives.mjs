import {execFileSync} from 'node:child_process';
export function packArchive(path,destination) {
  // Lifecycle output is human-readable; never mix it with npm's JSON result.
  execFileSync('npm',['run','build','--if-present'],{cwd:path,stdio:'inherit'});
  return JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',destination],{cwd:path,encoding:'utf8'}))[0];
}
