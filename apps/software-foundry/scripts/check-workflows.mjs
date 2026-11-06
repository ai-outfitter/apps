import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const entry of readdirSync(join(root, 'workflows'), { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const path = join(root, 'workflows', entry.name);
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  const result = spawnSync('npm', ['run', 'test', '--workspace', pkg.name], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
