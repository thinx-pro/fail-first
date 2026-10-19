#!/usr/bin/env node
// Run fail-first on a list of commits of a real repo and print a Markdown table.
//   node scripts/run-real.js <repo-dir> <sha> [<sha> ...] [-- extra fail-first args]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fail-first.js');
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const [dir, ...shas] = sep === -1 ? argv : argv.slice(0, sep);
const extra = sep === -1 ? [] : argv.slice(sep + 1);

console.log('| commit | subject | test file | before | after | verdict | why it failed before |');
console.log('|---|---|---|---|---|---|---|');
for (const sha of shas) {
  const subject = spawnSync('git', ['log', '-1', '--format=%s', sha], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [BIN, '--head', sha, '--json', ...extra], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    console.log(`| ${sha} | ${subject} | (error) | | | exit ${r.status} | ${(r.stderr || '').trim().slice(0, 120)} |`);
    continue;
  }
  for (const f of j.files) {
    console.log(
      `| ${sha} | ${subject.replace(/\|/g, '\\|').slice(0, 70)} | ${f.file} | ${f.before ?? 'skip'} | ${f.after} | ${f.verdict} | ${(f.why || '').replace(/\|/g, '\\|').slice(0, 110)} (${secs}s) |`,
    );
  }
  if (!j.files.length) console.log(`| ${sha} | ${subject} | (no tests) | | | | |`);
}
