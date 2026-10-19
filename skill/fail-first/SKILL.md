---
name: fail-first
description: Before saying a bug fix is done, prove the new or changed test fails on the old code and passes on the new code. Use after writing a fix plus a regression test, before committing or opening a PR.
---

# fail-first: prove the regression test

A regression test that passes on the old code does not test the fix. Check it before you report the fix as done.

## When

- You fixed a bug and added or changed a test for it.
- You are about to commit, open a PR, or tell the user "fixed, with a test".

## How

From the repository root, with your changes still uncommitted:

```bash
npx -y github:thinx-pro/fail-first
```

If you already committed the fix, it checks `HEAD~1 → HEAD` automatically. For a branch with several commits use `--base main` (or `origin/main`).

If the runner is not detected, pass it with `{file}` as the test file placeholder, for example:

```bash
npx -y github:thinx-pro/fail-first --cmd "uv run pytest -q {file}"
```

## Reading the result

- `PROVES`: good. Mention it in your summary ("the new test fails without the fix").
- `VACUOUS`: the test passes on the old code too. Do **not** report the fix as tested. Make the test reproduce the bug (use the exact input from the report, assert the specific wrong value), then run fail-first again.
- `BROKEN`: the test fails with your change. Fix the code or the test.
- `TESTS_ONLY`: only tests changed; nothing to prove. Fine for test-only work.
- `NO_RUNNER` / `EMPTY`: the command could not run the file. Pass `--cmd`.

Never weaken or delete a test to turn VACUOUS or BROKEN into a pass.
