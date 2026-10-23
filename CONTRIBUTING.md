# Style Guide

This document defines the style and conventions used in the J-ROCK Bitunix trader project.
All contributions should follow these rules unless otherwise noted.

The conventions are derived from the code already in `src/` — indent style, quoting,
naming, error handling, comment rationale, module layout, and the singleton-wiring
pattern — with the W3Schools JavaScript Style Guide as an external reference
(`fetchStyleURL` applied for language context).

## 1. General Code Style

- ESM only (`import`/`export`), `"type": "module"` in `package.json`. No build
  step, no bundler, no TypeScript.
- Favor clarity over brevity.
- Keep functions and methods small and focused.
- Avoid repeating logic; prefer shared helpers/utilities.
- Remove unused variables, imports, code paths, and files.
- Fail closed: with missing or invalid exchange data (liquidation price, klines,
  position tiers) refuse to act rather than guess.
- No dry-run mode: every order is a real Bitunix order. `auto_trade` must be off
  after every start; real orders only after `/autotrade` in Telegram.

## 2. Naming Conventions

| Item            | Convention           | Example                |
|-----------------|----------------------|------------------------|
| Variables       | `camelCase`          | `lastScan`, `entryPrice` |
| Functions       | `camelCase()`        | `computePositionSize()`  |
| Methods         | `camelCase()`        | `reconcilePositions()`   |
| Classes         | `PascalCase`         | `PositionManager`, `Trader` |
| Constants       | `UPPER_SNAKE_CASE`   | `WS_POSITION_GRACE_MS`   |
| File names      | `kebab-case`         | `position-manager.js`    |
| Modules         | `kebab-case`         | `src/bitunix/scanner.js` |

- Variable and function names start with a letter.
- Do not start identifiers with `$`.
- Export named classes/functions; default export only where one module naturally
  owns a single class (e.g. `Scanner` in `scanner.js`).

## 3. Formatting Rules

- Indentation: **2 spaces**, no tabs. Different editors interpret tabs differently,
  and the exchange tooling used by the repo assumes spaces.
- Line length: **max 80 characters** for readability; break long statements after
  an operator or comma.
- Encoding: **UTF-8**, no BOM.
- End files with a newline.
- Semicolons terminate every simple statement.
- One space around operators (`=`, `+`, `-`, `*`, `/`, `===`, `&&`, `||`) and
  after commas: `const x = y + z;` not `const x=y+z;`.

### Braces (K&R style)

Opening brace on the same line as the statement; closing brace on its own line
without leading spaces:

```js
if (condition) {
  doSomething();
} else {
  doSomethingElse();
}
```

Do not end a complex statement with a semicolon.

### Spacing

- One space after keywords: `if (x)`, not `if(x)`.
- One blank line between top-level functions and exported declarations.
- Quotes: single quotes (`'`) for strings unless the string itself contains a
  single quote; template literals only when interpolation is needed.

## 4. Comments & Documentation

- Explain **why**, not **what**, unless intent is unclear.
- Keep comments up-to-date as code changes.
- Public functions should include a short description of purpose and parameters.

Recommended tags (used throughout `src/`):

```text
TODO: follow-up work
FIXME: known incorrect behavior
DEPRECATED: no longer read by any code path, kept for compatibility
```

Comment rationale comments should often recount the incident or regression that
motivated the code (see `src/main.js`, `src/trader/trader.js`), so a reader
understands *why* a guard exists rather than merely *what* it does.

## 5. Error Handling

- Handle error conditions explicitly. Throw `Error` with human-readable messages.
- Do not log secrets — settings tools must redact `BITUNIX_API_SECRET`.
- Catch and `console.error` at loop boundaries; surface operator-visible failures
  into Telegram (position-lifecycle notifications, entry failures, poll failures),
  not just the console.
- Dedup repeated notices: a permanent entry failure (below the Bitunix minimum,
  leverage mismatch) reports once then backs off 30 minutes rather than spamming
  every scan.
- Always end an entry path with a take-profit **and** a stop-loss riding on the
  same order (`buildProtectedOrderBody` in `src/trader/trader.js`).
- Margin-mode arithmetic reads the account (`getLeverageAndMarginMode`), never
  `position_type`.
- A row reporting `liqPrice: "0"` on a live leveraged position means UNREPORTED,
  not safe: `PositionManager.effectiveLiqPrice` estimates the boundary and the
  guard/rearm/protection clamp use it.

## 6. Commit & Review Practices

### Commits

- One logical change per commit.
- Commit messages are short/freeform (e.g. "apply-fixes"); no conventional-commit
  format in history.
- Write clear commit messages:

```text
Short summary

Optional longer explanation of context and rationale.
```

- Never commit `.env` or log secrets.

### Reviews

- Keep pull requests reasonably small.
- Be respectful and constructive in review discussions.
- Address requested changes or explain if you disagree.
- New safety behavior needs a regression test that reproduces the failure path.

## 7. Tests

- Runner: `node --test` (built-in). No Jest, no Babel, no extra dependencies.
- File naming: `*.test.js` for test modules in `tests/`.
- Run: `npm test` (runs `tests/*.test.js` with `--test-concurrency=1`).
- Kline fixtures must be built in wire order (newest-first) and routed through
  `toChronological` (`asClientReturns`), matching what `BitunixClient.getKlines`
  returns.
- Stub `globalThis.fetch` / client objects instead of hitting the network.
- Tests should be deterministic (no randomness without seeding).
- Prefer readable test cases over complex test abstraction.

## 8. Changes to This Guide

Style evolves.
Propose improvements by opening an issue or sending a patch updating this document.
