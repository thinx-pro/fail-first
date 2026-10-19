// fail-first core: run the changed tests against the code *before* the change
// (they should fail) and *after* it (they should pass).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, detectRunner } from './classify.js';

export const LINK_DIRS = ['node_modules', '.venv', 'venv'];

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  }
  return r.status === 0 ? r.stdout : null;
}

export function repoRoot(cwd) {
  const out = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!out) throw new Error('not inside a git repository');
  return out.trim();
}

function isDirty(root) {
  const out = git(root, ['status', '--porcelain', '--untracked-files=all']);
  return out.trim().length > 0;
}

// Resolve what "before" and "after" mean.
//  - dirty tree, no flags:   before = HEAD,   after = working tree
//  - clean tree, no flags:   before = HEAD~1, after = HEAD
//  - --base X [--head Y]:    before = merge-base(X, Y), after = Y (default HEAD, or working tree if dirty and no --head)
export function resolveRange(root, { base, head } = {}) {
  const dirty = isDirty(root);
  let afterRef = head || (dirty ? null : 'HEAD');
  let beforeRef;
  if (base) {
    const tip = afterRef || 'HEAD';
    const mb = git(root, ['merge-base', base, tip], { allowFail: true });
    if (!mb) throw new Error(`cannot find a merge base between ${base} and ${tip}`);
    beforeRef = mb.trim();
  } else if (afterRef) {
    beforeRef = `${afterRef}~1`;
  } else {
    beforeRef = 'HEAD';
  }
  const before = git(root, ['rev-parse', '--verify', `${beforeRef}^{commit}`], { allowFail: true });
  if (!before) throw new Error(`cannot resolve ${beforeRef} (is this the first commit?)`);
  let after = null;
  if (afterRef) {
    const a = git(root, ['rev-parse', '--verify', `${afterRef}^{commit}`], { allowFail: true });
    if (!a) throw new Error(`cannot resolve ${afterRef}`);
    after = a.trim();
  }
  return {
    before: before.trim(),
    after, // null = working tree
    label: `${short(before.trim())} → ${after ? short(after) : 'working tree'}`,
  };
}

const short = (sha) => sha.slice(0, 8);

// Changed paths between before and after; status is A, M, D or R.
export function changedFiles(root, range) {
  const args = ['diff', '--name-status', '--no-renames', range.before];
  if (range.after) args.push(range.after);
  const out = git(root, args);
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [status, file] = line.split('\t');
    files.push({ status: status[0], file });
  }
  if (!range.after) {
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
    for (const f of untracked.split('\n')) if (f.trim()) files.push({ status: 'A', file: f.trim() });
  }
  return files;
}

function readAfter(root, range, file) {
  if (!range.after) return fs.readFileSync(path.join(root, file));
  const r = spawnSync('git', ['show', `${range.after}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`cannot read ${file} at ${range.after}`);
  return r.stdout;
}

function addWorktree(root, sha, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fail-first-${tag}-`));
  fs.rmSync(dir, { recursive: true, force: true });
  git(root, ['worktree', 'add', '--detach', '--quiet', dir, sha]);
  return dir;
}

function removeWorktree(root, dir) {
  git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
  fs.rmSync(dir, { recursive: true, force: true });
  git(root, ['worktree', 'prune'], { allowFail: true });
}

// Dependencies (node_modules, virtualenvs) are not in git; borrow them from the repo.
function linkDeps(root, dir, names) {
  for (const n of names) {
    const src = path.join(root, n);
    const dst = path.join(dir, n);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.symlinkSync(src, dst, 'dir');
      } catch {
        /* best effort */
      }
    }
  }
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function expandCmd(cmd, file) {
  const dir = path.posix.dirname(file);
  return cmd.replaceAll('{file}', shellQuote(file)).replaceAll('{dir}', shellQuote(dir === '.' ? '' : dir));
}

function runCmd(cmd, cwd, timeoutMs) {
  const t0 = Date.now();
  const env = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT; // we may ourselves be running under `node --test`
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  return {
    code: r.status,
    timedOut: r.error?.code === 'ETIMEDOUT' || (r.signal === 'SIGTERM' && r.status === null),
    ms: Date.now() - t0,
    output,
  };
}

const NO_TESTS_RX = /no tests ran|collected 0 items|No tests found|no test files|NO TESTS RAN|Ran 0 tests|0 passing/i;

export function outcome(res) {
  if (res.timedOut) return 'TIMEOUT';
  if (res.code === 0) return NO_TESTS_RX.test(res.output) && !/[1-9]\d* (passed|passing)/.test(res.output) ? 'EMPTY' : 'PASS';
  if (res.code === 5 && NO_TESTS_RX.test(res.output)) return 'EMPTY'; // pytest / unittest "no tests"
  if (res.code === 127 || /command not found|ModuleNotFoundError: No module named '?(pytest|vitest|jest)/.test(res.output))
    return 'NO_RUNNER';
  return 'FAIL';
}

// Pull the most telling line out of a failing run, for the "why it failed before" column.
export function reason(output) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const pick =
    lines.find((l) => /^E\s+\w*(Error|Exception)|^E\s+assert/.test(l)) ||
    lines.find((l) => /^\w*(Error|Exception)\b.*:\s*\S/.test(l)) ||
    lines.find((l) => /AssertionError|assert(ion)? failed|Expected|expected .* (to|but)/.test(l)) ||
    lines.find((l) => /(Error|Exception)\b/.test(l)) ||
    lines.find((l) => /not ok|FAIL:|ERROR:|FAIL\b/.test(l)) ||
    lines[lines.length - 1] ||
    '';
  return pick.replace(/^E\s+/, '').slice(0, 140);
}

export function verdict(before, after, sourceChanged) {
  if (after === 'NO_RUNNER' || before === 'NO_RUNNER') return 'NO_RUNNER';
  if (after === 'EMPTY') return 'EMPTY';
  if (after !== 'PASS') return 'BROKEN';
  if (!sourceChanged) return 'TESTS_ONLY';
  if (before === 'PASS') return 'VACUOUS';
  if (before === 'EMPTY') return 'PROVES';
  return 'PROVES';
}

export const VERDICT_INFO = {
  PROVES: 'fails before your change, passes after',
  VACUOUS: 'passes WITHOUT your change - it does not test the fix',
  BROKEN: 'fails after your change',
  TESTS_ONLY: 'only tests changed - nothing to prove against',
  EMPTY: 'runner found no tests in this file',
  NO_RUNNER: 'test runner not installed / command not found',
};

export async function check(opts) {
  const root = repoRoot(opts.cwd || process.cwd());
  const range = resolveRange(root, opts);
  const changes = changedFiles(root, range);
  const live = changes.filter((c) => c.status !== 'D').map((c) => c.file);
  const { tests, support, source } = classify(live, { testGlobs: opts.tests || [] });
  const deletedSource = changes.filter((c) => c.status === 'D' && !classify([c.file]).tests.length).length;
  const sourceChanged = source.length + deletedSource > 0;

  const result = {
    root,
    range: range.label,
    before: range.before,
    after: range.after || 'WORKTREE',
    sourceFiles: source,
    supportFiles: support,
    runner: null,
    cmd: null,
    files: [],
    summary: {},
  };
  if (!tests.length) {
    result.summary = summarize([]);
    return result;
  }

  const afterRoot = range.after ? null : root;
  const runner = opts.cmd ? { name: 'custom', cmd: opts.cmd } : detectRunner(afterRoot || root, tests);
  if (!runner) throw new Error(`could not guess how to run ${tests[0]}; pass --cmd "<command with {file}>"`);
  result.runner = runner.name;
  result.cmd = runner.cmd;
  const perFile = runner.cmd.includes('{file}') || runner.cmd.includes('{dir}');
  const units = perFile ? tests : ['(all)'];

  const linkNames = opts.link || LINK_DIRS;
  const timeoutMs = (opts.timeout || 300) * 1000;
  const trees = [];
  try {
    // BEFORE: old code + new tests (and their support files).
    let beforeDir = null;
    if (sourceChanged) {
      beforeDir = addWorktree(root, range.before, 'before');
      trees.push(beforeDir);
      for (const f of [...tests, ...support]) {
        const dst = path.join(beforeDir, f);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, readAfter(root, range, f));
      }
      linkDeps(root, beforeDir, linkNames);
    }
    // AFTER: the change as a whole.
    let afterDir = afterRoot;
    if (!afterDir) {
      afterDir = addWorktree(root, range.after, 'after');
      trees.push(afterDir);
      linkDeps(root, afterDir, linkNames);
    }

    for (const unit of units) {
      const cmd = perFile ? expandCmd(runner.cmd, unit) : runner.cmd;
      opts.onStart?.(unit);
      const a = runCmd(cmd, afterDir, timeoutMs);
      const aOut = outcome(a);
      let b = null;
      let bOut = null;
      if (beforeDir && aOut === 'PASS') {
        b = runCmd(cmd, beforeDir, timeoutMs);
        bOut = outcome(b);
      }
      const v = verdict(bOut, aOut, sourceChanged);
      const row = {
        file: unit,
        status: changes.find((c) => c.file === unit)?.status || '',
        before: bOut,
        after: aOut,
        verdict: v,
        ms: (a?.ms || 0) + (b?.ms || 0),
        why: v === 'PROVES' ? reason(b.output) : v === 'BROKEN' ? reason(a.output) : v === 'NO_RUNNER' ? reason(a.output) : '',
      };
      if (opts.verbose) {
        row.beforeOutput = b?.output;
        row.afterOutput = a.output;
      }
      result.files.push(row);
      opts.onDone?.(row);
    }
  } finally {
    if (!opts.keep) for (const t of trees) removeWorktree(root, t);
    else result.kept = trees;
  }
  result.summary = summarize(result.files);
  return result;
}

function summarize(rows) {
  const s = { total: rows.length };
  for (const k of Object.keys(VERDICT_INFO)) s[k] = rows.filter((r) => r.verdict === k).length;
  s.ok = s.VACUOUS === 0 && s.BROKEN === 0 && s.NO_RUNNER === 0;
  return s;
}
