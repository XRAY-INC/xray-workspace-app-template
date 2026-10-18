# Contributing

Thanks for helping make these apps better. They are copied into real services,
so the bar is "safe to copy", and every rule is held by a test.

## Getting set up

```bash
npm install
npx playwright install chromium   # once, for the browser test
npm run check                     # typecheck, unit, security, contract and browser tests
```

Node.js 20.9 or later; CI runs Node 20, 22 and 24.

## What makes a good change

- **Keep the apps dependency-light.** `zod` and `node:*` at runtime. A new
  runtime dependency needs a strong reason.
- **A fix comes with the test that would have caught it.** The security tests
  read as a specification; add the near-miss next to the rule it breaks.
- **Comments explain why.** These files are read more than they are run. If a
  rule exists because of an attack, say which one.
- **Don't edit `contract/` by hand.** Those files are generated from XRAY
  Workspace. If you think the workspace's contract is wrong, open an issue.
- **Don't add probe-only code paths.** Certification has to see the same
  handlers members use.

## Pull requests

1. Fork, branch, and make your change.
2. Run `npm run check`.
3. Open a pull request saying what changed and why.

By contributing you agree that your contribution is licensed under the
[MIT License](./LICENSE).

## Reporting security problems

Not through issues or pull requests: see [SECURITY.md](./SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
