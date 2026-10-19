// Decide which changed files are tests, and how to run them.
import fs from 'node:fs';
import path from 'node:path';

const TEST_FILE_RX = [
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)[^/]+_test\.py$/,
  /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/,
  /(^|\/)[^/]+_test\.go$/,
  /(^|\/)[^/]+_spec\.rb$/,
  /(^|\/)test_[^/]+\.rb$/,
  /(^|\/)[^/]+Tests?\.(java|kt|cs)$/,
  /(^|\/)tests\/[^/]+\.rs$/,
];

// Files that only exist to support tests (fixtures, conftest, snapshots).
// They travel with the tests into the "before" tree but are never run on their own.
const TEST_SUPPORT_RX = [
  /(^|\/)conftest\.py$/,
  /(^|\/)(tests?|__tests__|spec|testdata|fixtures|__fixtures__|__snapshots__)\//,
];

export function globToRegExp(glob) {
  let rx = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        rx += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else rx += '[^/]*';
    } else if (c === '?') rx += '[^/]';
    else rx += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${rx}$`);
}

export function classify(files, { testGlobs = [] } = {}) {
  const custom = testGlobs.map(globToRegExp);
  const tests = [];
  const support = [];
  const source = [];
  for (const f of files) {
    const isTest = custom.length ? custom.some((r) => r.test(f)) : TEST_FILE_RX.some((r) => r.test(f));
    if (isTest) tests.push(f);
    else if (TEST_SUPPORT_RX.some((r) => r.test(f))) support.push(f);
    else source.push(f);
  }
  return { tests, support, source };
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function hasText(p, rx) {
  try {
    return rx.test(fs.readFileSync(p, 'utf8'));
  } catch {
    return false;
  }
}

// Returns { name, cmd } where cmd may contain {file} / {dir}; null if unknown.
export function detectRunner(root, testFiles) {
  const exts = new Set(testFiles.map((f) => path.extname(f)));
  const py = fs.existsSync(path.join(root, '.venv/bin/python'))
    ? '.venv/bin/python'
    : fs.existsSync(path.join(root, 'venv/bin/python'))
      ? 'venv/bin/python'
      : 'python3';

  if (exts.has('.py')) {
    const usesPytest =
      hasText(path.join(root, 'pyproject.toml'), /pytest/) ||
      fs.existsSync(path.join(root, 'pytest.ini')) ||
      hasText(path.join(root, 'setup.cfg'), /tool:pytest/) ||
      hasText(path.join(root, 'tox.ini'), /pytest/) ||
      fs.existsSync(path.join(root, 'conftest.py')) ||
      testFiles.some((f) => hasText(path.join(root, f), /\bimport pytest\b|\bfrom pytest\b/));
    if (usesPytest) return { name: 'pytest', cmd: `${py} -m pytest -q -x -p no:cacheprovider {file}` };
    return { name: 'unittest', cmd: `${py} -m unittest {file}` };
  }
  if ([...exts].some((e) => /^\.[cm]?[jt]sx?$/.test(e))) {
    const pkg = readJSON(path.join(root, 'package.json')) || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vitest) return { name: 'vitest', cmd: 'npx --no-install vitest run {file}' };
    if (deps.jest) return { name: 'jest', cmd: 'npx --no-install jest {file}' };
    if (deps.mocha) return { name: 'mocha', cmd: 'npx --no-install mocha {file}' };
    if (deps.ava) return { name: 'ava', cmd: 'npx --no-install ava {file}' };
    return { name: 'node:test', cmd: 'node --test {file}' };
  }
  if (exts.has('.go')) return { name: 'go test', cmd: 'go test ./{dir}' };
  if (exts.has('.rs')) return { name: 'cargo test', cmd: 'cargo test' };
  if (exts.has('.rb')) {
    if (fs.existsSync(path.join(root, '.rspec')) || testFiles.some((f) => f.endsWith('_spec.rb')))
      return { name: 'rspec', cmd: 'bundle exec rspec {file}' };
    return { name: 'minitest', cmd: 'ruby -Itest {file}' };
  }
  return null;
}
