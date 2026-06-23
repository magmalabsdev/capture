// Compute the YY.MM.COMMIT app version from local git history (no network) and
// write it to electron/build-version.json so the packaged app can show a
// version without calling GitHub.

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

let version = '0.0.0';
try {
  const iso = git('log -1 --format=%cI');        // latest commit date, ISO 8601
  const d = new Date(iso);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const since = `${d.getUTCFullYear()}-${mm}-01T00:00:00`;
  const count = git(`rev-list --count --since="${since}" HEAD`); // commits this month
  version = `${yy}.${mm}.${count}`;
} catch (e) {
  console.warn('gen-version: git unavailable, using', version);
}

mkdirSync(join(root, 'electron'), { recursive: true });
writeFileSync(join(root, 'electron', 'build-version.json'), JSON.stringify({ version }, null, 2) + '\n');
console.log('gen-version:', version);
