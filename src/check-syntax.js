import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = path.resolve('src');
async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const files = await walk(root);
for (const file of files) {
  await exec(process.execPath, ['--check', file]);
}
console.log(`Syntax OK: ${files.length} JavaScript files`);
