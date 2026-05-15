// CI verification — confirms that every .html in the repo parses cleanly
// under HTML5 parsing rules, and every .js / .mjs has valid JavaScript syntax.
// Requires parse5 to be available (installed in CI via `npm install --no-save`).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'parse5';

const SKIP_DIRS = new Set(['node_modules', '.git', '.github']);

function walk(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, found);
    else found.push(p);
  }
  return found;
}

const root = process.cwd();
const files = walk(root);
const htmlFiles = files.filter((f) => extname(f) === '.html');
const jsFiles = files.filter((f) => extname(f) === '.js' || extname(f) === '.mjs');

let failed = false;

for (const file of htmlFiles) {
  const rel = relative(root, file);
  const errors = [];
  parse(readFileSync(file, 'utf8'), {
    sourceCodeLocationInfo: true,
    onParseError: (err) => errors.push(err),
  });
  if (errors.length > 0) {
    failed = true;
    console.error(`FAIL  ${rel}  (${errors.length} HTML parse error${errors.length === 1 ? '' : 's'})`);
    for (const err of errors.slice(0, 10)) {
      console.error(`        ${err.code} at line ${err.startLine}, col ${err.startCol}`);
    }
    if (errors.length > 10) console.error(`        ... and ${errors.length - 10} more`);
  } else {
    console.log(`ok    ${rel}`);
  }
}

for (const file of jsFiles) {
  const rel = relative(root, file);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed = true;
    console.error(`FAIL  ${rel}`);
    console.error(r.stderr.split('\n').map((l) => `        ${l}`).join('\n'));
  } else {
    console.log(`ok    ${rel}`);
  }
}

console.log('');
console.log(`Checked ${htmlFiles.length} HTML file${htmlFiles.length === 1 ? '' : 's'} and ${jsFiles.length} JS file${jsFiles.length === 1 ? '' : 's'}.`);

if (failed) process.exit(1);
