import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

export function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.name', 'test']);
  sh(dir, 'git', ['config', 'user.email', 'test@example.invalid']);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  return dir;
}

export function write(dir, files) {
  for (const [f, body] of Object.entries(files)) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}

export function commit(dir, files, msg = 'c') {
  write(dir, files);
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', msg]);
}

export const BUGGY = 'export const add = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n';
export const FIXED = 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n';

export const ADD_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.js';
test('add', () => assert.equal(add(2, 3), 5));
`;
export const MUL_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { mul } from '../src/math.js';
test('mul', () => assert.equal(mul(2, 3), 6));
`;
export const PKG = '{"type":"module"}\n';
