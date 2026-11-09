import {readdir, readFile} from 'node:fs/promises';
import {join, resolve, relative} from 'node:path';
import {createHash} from 'node:crypto';
import {validateMigrationLineage} from '@ai-outfitter/app-sdk/migrations';

/** Legacy SQL remains packaged verbatim. Baselines are optional, pinned metadata. */
export async function loadAppMigrations(directory, initial = []) {
  const folder = join(directory, 'migrations');
  const names = (await readdir(folder)).filter(name => name.endsWith('.sql')).sort();
  if (!names.length) throw new Error(`No migrations in ${folder}`);
  const migrations = [...initial, ...await Promise.all(names.map(async name => ({name:name.slice(0,-4),sql:await readFile(join(folder,name),'utf8')})))];
  let metadata;
  try { metadata = await readFile(join(directory,'migration-baseline.json'),'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {migrations}; throw error; }
  const config = JSON.parse(metadata);
  if (config.version !== 1 || !Array.isArray(config.baselines) || Object.keys(config).some(key => !['version','baselines'].includes(key))) throw new Error('Invalid migration baseline metadata');
  const baselines = await Promise.all(config.baselines.map(async entry => {
    if (!entry || Object.keys(entry).some(key => !['name','file','sha256','replaces'].includes(key)) || typeof entry.file !== 'string' || !/^migrations\/baselines\/[a-z0-9_-]+\.sql$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid migration baseline entry');
    const filename = resolve(directory,entry.file);
    if (relative(resolve(directory),filename).startsWith('..')) throw new Error('Invalid baseline path');
    const sql = await readFile(filename,'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== entry.sha256) throw new Error('Migration baseline digest mismatch');
    return {name:entry.name,sql,replaces:entry.replaces};
  }));
  const lineage = validateMigrationLineage(migrations,baselines);
  return {migrations:lineage.migrations,baselines:lineage.baselines};
}
