# Fork maintenance

This public repository is the personal fork of `vincentkoc/tokenjuice`; its operator has read-only upstream permission. In the canonical maintenance checkout, `upstream` tracks the public upstream and `fork` publishes owned work. The registry at [`config/local-aggregate-features.json`](../config/local-aggregate-features.json) is authoritative; train manifests freeze release selections.

## Shared workflow

Install `hxy91819/mason-skills` revision `d52dc81d55a017f56b5c1d41feb345e4084a25fd`, then expose `common-skills/open-source-fork-maintenance` as `.agents/skills/open-source-fork-maintenance`. The migration used the skill whose latest path-specific commit was `0b97108d564eb40c01af4ecd36ef1dc624519df1`. A checkout-local relative symlink is intentionally ignored because its target depends on where the shared skills repository is installed.

Use `$open-source-fork-maintenance` for source registration, upstream updates, train composition, and packaging. Keep the root checkout on `local/aggregate` after cutover. Feature and fix work belongs in separate worktrees and first-tier branches. This registry is direct-only until recurring shared adaptation justifies a domain.

## Verification and delivery

Supported runtime and package manager versions come from `package.json` (`node >=20`, `pnpm@10.11.0`). Install with `pnpm install --frozen-lockfile`. The source gate is `pnpm verify`; the packaging gate is `pnpm release:local`. Run gates against the exact candidate in an isolated worktree and keep generated `dist/` and `release/` output out of source commits. The project has no service deployment step. npm, GitHub Release, and Homebrew publication remain governed by the existing release process and are not authorized merely by a maintenance migration.

## Migration baseline

The preserved legacy aggregate is commit `a01230c6eba807a5182e911935a4ebc2bfba807e`, tree `1fcaccc19900aaf5f9fe34430b5bda30f37ccccd`, based on stable tag `v0.8.1` at `49bdcf1755833ff1e02e44e6e7fe91c0fb44c16e`. Immutable ref `fork-backup/pre-v4-20260921-a01230c` preserves it and all selected historical source objects.

The migration retains every legacy tree change through the explicit ordered selections in the first frozen train. Changes already reported or adopted upstream remain selected because structural migration keeps the existing baseline. Upstream stable `v0.8.5` is release debt to address in a separate train; adoption must be checked behaviorally before retiring any local selection. Historical fork branches outside the frozen train remain contribution/history refs and are not implied aggregate inputs.
