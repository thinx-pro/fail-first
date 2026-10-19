#!/usr/bin/env node
import { check, VERDICT_INFO, LINK_DIRS } from '../src/core.js';

const VERSION = '0.1.0';

const HELP = `fail-first ${VERSION}
Prove your new tests fail without your change.

Runs the tests you added or changed twice: against the code BEFORE your change
(they should fail) and AFTER it (they should pass). A test that passes both
times does not test your fix.

Usage
  npx github:thinx-pro/fail-first [options]

What gets compared (default)
  uncommitted changes   HEAD           vs working tree
  clean tree            HEAD~1         vs HEAD
  --base <ref>          merge-base     vs HEAD (or working tree if dirty)

Options
  --base <ref>        compare against this ref, e.g. origin/main
  --head <ref>        the "after" commit (default: HEAD / working tree)
  --cmd "<command>"   test command; {file} = test file, {dir} = its folder.
                      Without a placeholder the command runs once for all tests.
                      Default: guessed (pytest, unittest, vitest, jest, mocha,
                      ava, node --test, go test, cargo test, rspec, minitest)
  --tests <glob>      which changed files count as tests (repeatable),
                      e.g. --tests "src/**/*.check.ts"
  --link <dir>        untracked dirs to borrow into the temp trees (repeatable;
                      default: ${LINK_DIRS.join(', ')})
  --timeout <sec>     per test run (default 300)
  --json              machine-readable output
  --md                Markdown table (for PR comments)
  --keep              keep the temporary worktrees for debugging
  --verbose           print test output for each run
  -h, --help          show this help
  -v, --version       show version

Exit codes
  0  every changed test fails before and passes after (or nothing to check)
  1  at least one test is VACUOUS, BROKEN, or could not run
  2  usage error / not a git repo

Verdicts
${Object.entries(VERDICT_INFO)
  .map(([k, v]) => `  ${k.padEnd(11)} ${v}`)
  .join('\n')}
`;

function parse(argv) {
  const o = { tests: [], link: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '--base') o.base = val();
    else if (a === '--head') o.head = val();
    else if (a === '--cmd') o.cmd = val();
    else if (a === '--tests') o.tests.push(val());
    else if (a === '--link') (o.link ||= []).push(val());
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '--json') o.json = true;
    else if (a === '--md') o.md = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--verbose') o.verbose = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (o.timeout !== undefined && !(o.timeout > 0)) throw new Error('--timeout must be a positive number');
  return o;
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1);
const dim = c(2);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);

const BADGE = {
  PROVES: green('✔ PROVES'),
  VACUOUS: yellow('⚠ VACUOUS'),
  BROKEN: red('✖ BROKEN'),
  TESTS_ONLY: dim('· TESTS_ONLY'),
  EMPTY: dim('· EMPTY'),
  NO_RUNNER: red('✖ NO_RUNNER'),
};
const cell = (o) => (o === null ? dim('skip') : o === 'PASS' ? green('pass') : o === 'FAIL' ? red('fail') : yellow(o.toLowerCase()));

function printHuman(r) {
  console.log(`${bold('fail-first')} ${dim(r.range)}`);
  if (!r.files.length) {
    console.log(dim('No changed test files. Nothing to prove.'));
    if (r.sourceFiles.length) console.log(yellow(`  ${r.sourceFiles.length} source file(s) changed without any test change.`));
    return;
  }
  console.log(dim(`runner: ${r.runner}  ·  ${r.cmd}`));
  console.log(dim(`source files changed: ${r.sourceFiles.length}${r.supportFiles.length ? `  ·  test support files: ${r.supportFiles.length}` : ''}`));
  console.log('');
  const w = Math.min(60, Math.max(...r.files.map((f) => f.file.length)));
  console.log(dim(`${'test file'.padEnd(w)}  before  after  verdict`));
  for (const f of r.files) {
    const name = f.file.length > w ? `…${f.file.slice(-(w - 1))}` : f.file.padEnd(w);
    console.log(`${name}  ${pad(cell(f.before), 6)}  ${pad(cell(f.after), 5)}  ${BADGE[f.verdict]}`);
    if (f.why) console.log(`${' '.repeat(w)}  ${dim(`└ ${f.verdict === 'PROVES' ? 'before: ' : ''}${f.why}`)}`);
    if (f.beforeOutput) console.log(dim(indent(`--- before ---\n${f.beforeOutput}`)));
    if (f.afterOutput) console.log(dim(indent(`--- after ---\n${f.afterOutput}`)));
  }
  console.log('');
  const s = r.summary;
  const parts = [];
  for (const k of Object.keys(VERDICT_INFO)) if (s[k]) parts.push(`${s[k]} ${k}`);
  console.log(`${s.ok ? green(bold('OK')) : red(bold('NOT PROVEN'))}  ${parts.join(' · ')}`);
  if (s.VACUOUS) console.log(yellow('  VACUOUS tests pass on the old code too: they would not catch this bug coming back.'));
  if (s.TESTS_ONLY) console.log(dim('  Only test files changed, so there is no "before" to fail against.'));
  if (r.kept) console.log(dim(`  kept worktrees: ${r.kept.join(', ')}`));
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}
function pad(s, n) {
  return s + ' '.repeat(Math.max(0, n - stripAnsi(s).length));
}
function indent(s) {
  return s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

function printMd(r) {
  const out = [`### fail-first: ${r.summary.ok ? '✅ tests prove the change' : '⚠️ not proven'}`, '', `\`${r.range}\` · runner: ${r.runner || 'n/a'}`, ''];
  if (!r.files.length) out.push('_No changed test files._');
  else {
    out.push('| test file | before change | after change | verdict |', '|---|---|---|---|');
    for (const f of r.files) out.push(`| \`${f.file}\` | ${f.before ?? 'skip'} | ${f.after} | **${f.verdict}**${f.why ? ` — ${f.why.replace(/\|/g, '\\|')}` : ''} |`);
  }
  console.log(out.join('\n'));
}

async function main() {
  let o;
  try {
    o = parse(process.argv.slice(2));
  } catch (e) {
    console.error(`fail-first: ${e.message}\nTry --help`);
    process.exit(2);
  }
  if (o.help) return console.log(HELP);
  if (o.version) return console.log(VERSION);
  const quiet = o.json || o.md;
  if (!quiet && process.stderr.isTTY) {
    o.onStart = (f) => process.stderr.write(dim(`  running ${f} …\r`));
    o.onDone = () => process.stderr.write('\x1b[2K\r');
  }
  let r;
  try {
    r = await check(o);
  } catch (e) {
    console.error(`fail-first: ${e.message}`);
    process.exit(2);
  }
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else if (o.md) printMd(r);
  else printHuman(r);
  process.exit(r.summary.ok ? 0 : 1);
}

main();
