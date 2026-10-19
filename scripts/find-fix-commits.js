#!/usr/bin/env node
// List recent non-merge commits that change both source and test files.
// Used to pick real-world cases for the README "tested on" section.
//   node scripts/find-fix-commits.js <repo-dir> [maxCommits=300] [grep=fix]
import { spawnSync } from 'node:child_process';
import { classify } from '../src/classify.js';

const [dir, max = '300', grep = 'fix'] = process.argv.slice(2);
if (!dir) {
  console.error('usage: find-fix-commits.js <repo-dir> [maxCommits] [grep]');
  process.exit(2);
}
const log = spawnSync(
  'git',
  ['log', '--no-merges', `-n${max}`, '-i', `--grep=${grep}`, '--name-only', '--format=@@%h %ad %s', '--date=short'],
  { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 },
).stdout;
for (const block of log.split('@@').filter(Boolean)) {
  const [head, ...files] = block.trim().split('\n').filter(Boolean);
  const c = classify(files);
  const src = c.source.filter((f) => !/\.(md|txt|rst|ya?ml|json|lock|toml|cfg)$/.test(f));
  if (c.tests.length && src.length) console.log(`${head}  [tests:${c.tests.length} src:${src.length}]`);
}
