// Newer npm versions can skip install scripts, and Electron's script is what downloads its program.
// This runs before `npm run desktop` and fetches it when it is missing.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'electron');
if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, 'path.txt'))) {
  console.log('Downloading Electron (once)...');
  const r = spawnSync(process.execPath, ['install.js'], { cwd: dir, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
