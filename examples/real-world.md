# fail-first on real fix commits

Run on 2026-10-19 with fail-first 0.1.0, macOS, Node 24, Python 3.14.
Commits were picked with `scripts/find-fix-commits.js` (recent commits whose message mentions "fix" and that touch both source and test files), then checked with `scripts/run-real.js`, which runs `fail-first --head <sha> --json` (before = `<sha>~1`, after = `<sha>`).

Reproduce:

```bash
git clone https://github.com/more-itertools/more-itertools && cd more-itertools
node /path/to/fail-first/scripts/run-real.js . 67fcf64 def2dab 6b1907d 5c715d8 d992be0 958990e f51a53b edb3346 d71c4ad be5793a 06f3181 def2d82
```

For ufo, install dev dependencies first (`npm install --legacy-peer-deps`; the repo uses pnpm).

**Totals: 23 commits, 26 changed test files. 20 PROVES, 6 VACUOUS, 0 BROKEN.**

Every VACUOUS row was opened and read by hand. They fall into two groups:

- **Expected.** The commit is a refactor or a test clean-up, so no new failing test is possible: ufo `9713f2f` (rewrites a regex to avoid lookbehind for older browsers; the behaviour is the same in Node), more-itertools `5c715d8` (test coverage work).
- **Worth a look.** ufo `3cd8c3f`: the new `//test.com` case already passed before the fix. more-itertools `d71c4ad`: the fix keeps the internal `_marker` sentinel away from user predicates, but the test change only loosens three lambdas to `lambda *args: True`. Nothing asserts that a predicate never receives `_marker`, so the fix could regress without a test failing.

This does not mean the fixes are wrong. It means the test suite does not lock them in.

## more-itertools (unittest)

| commit | subject | test file | before | after | verdict | why it failed before |
|---|---|---|---|---|---|---|
| 67fcf64 | fix: honour a falsey validator in bucket (#1308) | tests/test_more.py | FAIL | PASS | PROVES | AssertionError: Lists differ: [10] != [] |
| def2dab | Fix one()/only() dropping a falsy user-supplied exception | tests/test_more.py | FAIL | PASS | PROVES | FalsyError, lambda: mi.one(count(), too_long=too_long) |
| 6b1907d | fix: seekable.peek/bool no longer drop items when maxlen is 0 | tests/test_more.py | FAIL | PASS | PROVES | AssertionError: Lists differ: [20, 30] != [10, 20, 30] |
| 5c715d8 | test: close the last coverage gaps, fix a no-op equality assertion | tests/test_more.py | PASS | PASS | VACUOUS | |
| 5c715d8 | (same) | tests/test_recipes.py | PASS | PASS | VACUOUS | |
| d992be0 | Fix stability in running_min and running_max | tests/test_more.py | FAIL | PASS | PROVES | AssertionError: Lists differ: [int, float, Fraction] != … |
| 958990e | Raise for negative slice sizes in sliced() | tests/test_more.py | FAIL | PASS | PROVES | AssertionError: ValueError not raised by &lt;lambda&gt; |
| f51a53b | fix: handle empty interleave_evenly input | tests/test_more.py | FAIL | PASS | PROVES | IndexError: list index out of range |
| edb3346 | Fix empty ranges in numeric_range.\_\_reversed\_\_ | tests/test_more.py | FAIL | PASS | PROVES | IndexError: numeric range object index out of range |
| d71c4ad | fix: prevent _marker from being passed to user predicates in replace() and locate() | tests/test_more.py | PASS | PASS | VACUOUS | |
| be5793a | Two fixes for repeat with iterator arguments | tests/test_more.py | FAIL | PASS | PROVES | ValueError: each iterable must have two or more items |
| 06f3181 | Simplify nth_combination_with_replacement. Fix incorrect exception. | tests/test_more.py | FAIL | PASS | PROVES | raise ValueError |
| def2d82 | Simplify nth_permutation. Fix incorrect exception. | tests/test_recipes.py | FAIL | PASS | PROVES | raise ValueError |

Each run took 5–14 s (the test file is large and runs twice).

## unjs/ufo (vitest)

| commit | subject | test file | before | after | verdict | why it failed before |
|---|---|---|---|---|---|---|
| 5cd9e67 | fix(withoutBase): collapse leading slashes (#335) | test/base.test.ts | FAIL | PASS | PROVES | expected '//evil.com' to be '/evil.com' |
| eb29945 | fix(withBase, withoutBase): prevent false prefix matches (#313) | test/base.test.ts | FAIL | PASS | PROVES | expected '/admin-dashboard' to be '/admin/admin-dashboard' |
| 7959de5 | fix(parseFilename): use optional chaining to access `opts.strict` (#284) | test/parse.test.ts | FAIL | PASS | PROVES | TypeError: Cannot destructure property 'strict' of 'undefined' |
| 4d024df | fix(parseQuery): use object with null prototype (#286) | test/query.test.ts | FAIL | PASS | PROVES | expected { toString: [ …(2) ] } to match object { toString: 'foo' } |
| 62199a0 | fix(withProtocol): consider relative protocol (#242) | test/utilities.test.ts | FAIL | PASS | PROVES | expected 'https:////example.com' to be 'https://example.com' |
| 229e83e | fix(parseURL): only normalize windows drive letters with `file://` protocol (#246) | test/parse.test.ts | FAIL | PASS | PROVES | expected { protocol: 'https:', … } to deeply equal { … } |
| 9713f2f | fix(joinRelativeURL): avoid lookbehind regex for browser compatibility (#228) | test/join.test.ts | PASS | PASS | VACUOUS | |
| 3910926 | fix(joinRelativeURL): handle base with protocol (#222) | test/join.test.ts | FAIL | PASS | PROVES | expected 'https:/google.com/foo/bar' to be 'https://google.com/foo/bar' |
| 6cd1fcd | fix(withoutTrailingSlash): consider qurry param (#219) | test/trailing-slash.test.ts | FAIL | PASS | PROVES | expected 'fo?k=/' to be 'foo?k=/' |
| 3cd8c3f | fix: stringify protocol-relative URLs (#207) | test/parse.test.ts | PASS | PASS | VACUOUS | |
| 3cd8c3f | (same) | test/utilities.test.ts | PASS | PASS | VACUOUS | |
| 47f4070 | fix(encodeQueryValue): encode the slash character (#198) | test/encoding.test.ts | FAIL | PASS | PROVES | expected '!@%23$%25^…' to strictly equal '…' |
| 47f4070 | (same) | test/normalize.test.ts | FAIL | PASS | PROVES | expected 'http://localhost/?redirect=http://goo…' to be '…%2F%2…' |

Each run took 1–2 s.
