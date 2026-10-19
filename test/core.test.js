import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, outcome, verdict } from '../src/core.js';
import { classify, globToRegExp, detectRunner } from '../src/classify.js';
import { makeRepo, commit, write, sh, BUGGY, FIXED, ADD_TEST, MUL_TEST, PKG } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fail-first.js');
const cli = (cwd, args = []) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

test('fix + new test that catches the bug -> PROVES', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  commit(d, { 'src/math.js': FIXED, 'test/add.test.js': ADD_TEST }, 'fix add');
  const r = await check({ cwd: d });
  assert.equal(r.runner, 'node:test');
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].before, 'FAIL');
  assert.equal(r.files[0].after, 'PASS');
  assert.equal(r.files[0].verdict, 'PROVES');
  assert.match(r.files[0].why, /Expected|5|-1|assert/i);
  assert.equal(r.summary.ok, true);
});

test('test that passes on old code too -> VACUOUS', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  commit(d, { 'src/math.js': FIXED, 'test/mul.test.js': MUL_TEST }, 'fix add, test mul');
  const r = await check({ cwd: d });
  assert.equal(r.files[0].verdict, 'VACUOUS');
  assert.equal(r.summary.ok, false);
});

test('test that fails after the change -> BROKEN, before is skipped', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  commit(d, { 'src/math.js': BUGGY.replace('a * b', 'a * b + 1'), 'test/add.test.js': ADD_TEST });
  const r = await check({ cwd: d });
  assert.equal(r.files[0].verdict, 'BROKEN');
  assert.equal(r.files[0].before, null);
});

test('uncommitted changes: HEAD vs working tree, untracked test file included', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  write(d, { 'src/math.js': FIXED, 'test/add.test.js': ADD_TEST, 'test/mul.test.js': MUL_TEST });
  const r = await check({ cwd: d });
  assert.equal(r.after, 'WORKTREE');
  const by = Object.fromEntries(r.files.map((f) => [f.file, f.verdict]));
  assert.deepEqual(by, { 'test/add.test.js': 'PROVES', 'test/mul.test.js': 'VACUOUS' });
  // the user's tree is untouched
  assert.equal(sh(d, 'git', ['status', '--porcelain']).includes('src/math.js'), true);
});

test('only tests changed -> TESTS_ONLY and no "before" run', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': FIXED });
  commit(d, { 'test/add.test.js': ADD_TEST });
  const r = await check({ cwd: d });
  assert.equal(r.files[0].verdict, 'TESTS_ONLY');
  assert.equal(r.summary.ok, true);
});

test('no test changes -> empty result, ok', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  commit(d, { 'src/math.js': FIXED });
  const r = await check({ cwd: d });
  assert.equal(r.files.length, 0);
  assert.deepEqual(r.sourceFiles, ['src/math.js']);
  assert.equal(r.summary.ok, true);
});

test('--base uses the merge base of a feature branch with several commits', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  sh(d, 'git', ['checkout', '-q', '-b', 'feature']);
  commit(d, { 'test/add.test.js': ADD_TEST }, 'red test first');
  commit(d, { 'src/math.js': FIXED }, 'green');
  sh(d, 'git', ['checkout', '-q', 'main']);
  commit(d, { 'README.md': 'unrelated\n' }, 'main moves on');
  sh(d, 'git', ['checkout', '-q', 'feature']);
  const r = await check({ cwd: d, base: 'main' });
  assert.equal(r.files[0].verdict, 'PROVES');
  // default range (HEAD~1..HEAD) only sees the fix commit, with no test change
  const r2 = await check({ cwd: d });
  assert.equal(r2.files.length, 0);
});

test('modified existing test file: new assertions run against old code', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY, 'test/math.test.js': MUL_TEST });
  commit(d, { 'src/math.js': FIXED, 'test/math.test.js': MUL_TEST + ADD_TEST.split('\n').slice(2).join('\n') });
  const r = await check({ cwd: d });
  assert.equal(r.files[0].status, 'M');
  assert.equal(r.files[0].verdict, 'PROVES');
});

test('test support files (fixtures) travel with the tests', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  commit(d, {
    'src/math.js': FIXED,
    'test/fixtures/cases.json': '[[2,3,5],[1,1,2]]\n',
    'test/cases.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { add } from '../src/math.js';
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/cases.json', import.meta.url)));
test('cases', () => { for (const [a, b, s] of cases) assert.equal(add(a, b), s); });
`,
  });
  const r = await check({ cwd: d });
  assert.deepEqual(r.supportFiles, ['test/fixtures/cases.json']);
  assert.equal(r.files[0].verdict, 'PROVES');
  assert.doesNotMatch(r.files[0].why, /ENOENT/);
});

test('python unittest is detected and run per file', async () => {
  const d = makeRepo();
  commit(d, { 'calc.py': 'def add(a, b):\n    return a - b\n' });
  commit(d, {
    'calc.py': 'def add(a, b):\n    return a + b\n',
    'test_calc.py': 'import unittest\nfrom calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\nif __name__ == "__main__":\n    unittest.main()\n',
  });
  const r = await check({ cwd: d });
  assert.equal(r.runner, 'unittest');
  assert.equal(r.files[0].verdict, 'PROVES');
  assert.match(r.files[0].why, /AssertionError|-1 != 5/);
});

test('--cmd without placeholder runs once for all tests', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  commit(d, { 'src/math.js': FIXED, 'test/add.test.js': ADD_TEST, 'test/mul.test.js': MUL_TEST });
  const r = await check({ cwd: d, cmd: 'node --test test/add.test.js test/mul.test.js' });
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].file, '(all)');
  assert.equal(r.files[0].verdict, 'PROVES');
});

test('missing runner -> NO_RUNNER, not a false PROVES', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  commit(d, { 'src/math.js': FIXED, 'test/add.test.js': ADD_TEST });
  const r = await check({ cwd: d, cmd: 'definitely-not-a-real-runner-xyz {file}' });
  assert.equal(r.files[0].verdict, 'NO_RUNNER');
  assert.equal(r.summary.ok, false);
});

test('temporary worktrees are cleaned up', async () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  commit(d, { 'src/math.js': FIXED, 'test/add.test.js': ADD_TEST });
  await check({ cwd: d, head: 'HEAD' });
  const list = sh(d, 'git', ['worktree', 'list']).trim().split('\n');
  assert.equal(list.length, 1);
});

test('CLI: exit codes, --json, --md, --help, bad flag', () => {
  const d = makeRepo();
  commit(d, { 'package.json': PKG, 'src/math.js': BUGGY });
  commit(d, { 'src/math.js': FIXED, 'test/mul.test.js': MUL_TEST });
  const j = cli(d, ['--json']);
  assert.equal(j.status, 1);
  assert.equal(JSON.parse(j.stdout).files[0].verdict, 'VACUOUS');
  const m = cli(d, ['--md']);
  assert.match(m.stdout, /\| `test\/mul.test.js` \| PASS \| PASS \| \*\*VACUOUS\*\*/);
  const h = cli(d, ['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--base <ref>/);
  assert.equal(cli(d, ['--nope']).status, 2);
  const human = cli(d, []);
  assert.match(human.stdout, /VACUOUS/);
  assert.match(human.stdout, /NOT PROVEN/);
});

test('CLI: outside a git repo -> exit 2', () => {
  const r = cli(path.parse(process.cwd()).root, []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not inside a git repository/);
});

test('classify + globs', () => {
  const r = classify([
    'src/a.py', 'tests/test_a.py', 'a_test.go', 'web/x.spec.tsx', 'lib/__tests__/y.js',
    'tests/conftest.py', 'tests/data/in.txt', 'spec/user_spec.rb', 'README.md',
  ]);
  assert.deepEqual(r.tests, ['tests/test_a.py', 'a_test.go', 'web/x.spec.tsx', 'lib/__tests__/y.js', 'spec/user_spec.rb']);
  assert.deepEqual(r.support, ['tests/conftest.py', 'tests/data/in.txt']);
  assert.deepEqual(r.source, ['src/a.py', 'README.md']);
  assert.ok(globToRegExp('src/**/*.check.ts').test('src/a/b/c.check.ts'));
  assert.ok(globToRegExp('src/**/*.check.ts').test('src/c.check.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.deepEqual(classify(['src/c.check.ts', 'src/c.ts'], { testGlobs: ['src/**/*.check.ts'] }).tests, ['src/c.check.ts']);
});

test('outcome / verdict table', () => {
  assert.equal(outcome({ code: 0, output: '3 passed' }), 'PASS');
  assert.equal(outcome({ code: 5, output: 'collected 0 items\nno tests ran' }), 'EMPTY');
  assert.equal(outcome({ code: 1, output: 'AssertionError' }), 'FAIL');
  assert.equal(outcome({ code: 127, output: 'sh: foo: command not found' }), 'NO_RUNNER');
  assert.equal(outcome({ code: null, timedOut: true, output: '' }), 'TIMEOUT');
  assert.equal(verdict('FAIL', 'PASS', true), 'PROVES');
  assert.equal(verdict('PASS', 'PASS', true), 'VACUOUS');
  assert.equal(verdict(null, 'FAIL', true), 'BROKEN');
  assert.equal(verdict(null, 'PASS', false), 'TESTS_ONLY');
});

test('detectRunner reads package.json and python config', () => {
  const d = makeRepo();
  write(d, { 'package.json': '{"devDependencies":{"vitest":"^3"}}' });
  assert.equal(detectRunner(d, ['a.test.ts']).name, 'vitest');
  write(d, { 'pyproject.toml': '[tool.pytest.ini_options]\n' });
  assert.equal(detectRunner(d, ['tests/test_a.py']).name, 'pytest');
  assert.equal(detectRunner(d, ['x_test.go']).cmd, 'go test ./{dir}');
  assert.equal(detectRunner(d, ['README.txt']), null);
});
