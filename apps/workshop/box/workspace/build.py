#!/usr/bin/env python3
"""Generic workspace CAD build. Run inside the Workshop box/runtime image.
A project supplies workspace.json with configure command, OpenSCAD targets,
assembly, parameters, and geometric checks. No design-specific code lives here.
"""
import argparse, datetime, hashlib, json, os, pathlib, subprocess, socket, shutil
import trimesh

def digest(data): return hashlib.sha256(data).hexdigest()
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
def run(args,cwd):
 p=subprocess.run(args,cwd=cwd,capture_output=True,text=True,timeout=180)
 return p

def build(root, output, overrides):
 root=pathlib.Path(root).resolve(); output=pathlib.Path(output).resolve();output.mkdir(parents=True,exist_ok=True)
 started=now(); git=run(['git','rev-parse','HEAD'],root)
 if git.returncode: raise ValueError('Workspace must be a git checkout')
 commit=git.stdout.strip()
 relative=run(['git','rev-parse','--show-prefix'],root).stdout.strip()
 if run(['git','status','--porcelain','--','.'],root).stdout.strip(): raise ValueError('Commit source changes before building')
 config=json.loads((root/'workspace.json').read_text())
 params={**config.get('parameters',{}),**overrides}
 generated=output/'configured';generated.mkdir(exist_ok=True)
 if config.get('configure'):
  p=run([*config['configure'],str(generated),json.dumps(params)],root)
  if p.returncode: raise ValueError(p.stderr or p.stdout)
  config={**config,**json.loads((generated/'assembly.json').read_text())}
 artifacts=[]; logs=[]; tests=list(config.get('tests',[]))
 def artifact(name,data,ctype):
  h=digest(data); path=f'{h}/{name}';dest=output/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
  artifacts.append(dict(path=path,sha256=h,bytes=len(data),contentType=ctype));return path
 for target in config['targets']:
  source=(generated/target['source']) if (generated/target['source']).exists() else root/target['source']
  stl=output/(target['id']+'.stl')
  p=run(['openscad','-o',str(stl),str(source)],root);logs.append({'target':target['id'],'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
  if p.returncode: raise ValueError(f"{target['id']}: {p.stderr}")
  mesh=trimesh.load_mesh(stl)
  valid=bool(mesh.is_watertight and mesh.is_winding_consistent and mesh.volume>0)
  tests.append(dict(name=f"Solid {target['id']}",status='pass' if valid else 'fail',detail=f'Watertight={mesh.is_watertight}; volume={mesh.volume:.4f} mm3'))
  path=artifact(stl.name,stl.read_bytes(),'model/stl')
  item=next((i for i in config['assembly']['items'] if i['id']==target['id']),None)
  if item is None: raise ValueError(f"Target {target['id']} is missing from the assembly")
  item['mesh']={'path':path,'bounds':{'min':mesh.bounds[0].tolist(),'max':mesh.bounds[1].tolist()}}
 for check in config.get('checks',[]):
  source=generated/check['source'];stl=output/(check['name']+'.stl')
  p=run(['openscad','-o',str(stl),str(source)],root)
  empty='Current top level object is empty' in p.stderr
  volume=abs(trimesh.load_mesh(stl).volume) if stl.exists() else 0
  passed=(empty or p.returncode==0) and volume<=check.get('maxVolume',0.1)
  tests.append(dict(name=check['name'],status='pass' if passed else 'fail',detail=f'OpenSCAD Boolean intersection {volume:.6f} mm3; empty={empty}; exit={p.returncode}'))
  logs.append({'check':check['name'],'stderr':p.stderr,'exitCode':p.returncode})
 compiler=run(['openscad','--version'],root); compiler=(compiler.stdout+compiler.stderr).strip()
 artifact('build-log.json',json.dumps(logs,indent=2).encode(),'application/json')
 # A portable source archive is tied to the exact commit, not an uncommitted filesystem copy.
 repo_root=run(['git','rev-parse','--show-toplevel'],root).stdout.strip()
 archive=subprocess.check_output(['git','archive','--format=tar',commit,relative or '.'],cwd=repo_root)
 artifact('source.tar',archive,'application/x-tar')
 artifact('assembly.json',json.dumps(config['assembly'],indent=2).encode(),'application/json')
 manifest=dict(version=1,units='mm',sourceCommit=commit,sourceHash=digest(archive),compiler=compiler,runner=f'container:{socket.gethostname()}',parameters=params,assembly=config['assembly'],artifacts=artifacts,tests=tests,notes=config.get('notes',''),startedAt=started,finishedAt=now())
 (output/'manifest.json').write_text(json.dumps(manifest,indent=2))
 return manifest
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('workspace');p.add_argument('output');p.add_argument('--parameters',default='{}');a=p.parse_args()
 m=build(a.workspace,a.output,json.loads(a.parameters));print(json.dumps({'tests':m['tests'],'manifest':str(pathlib.Path(a.output)/'manifest.json')}));raise SystemExit(any(t['status']=='fail' for t in m['tests']))
