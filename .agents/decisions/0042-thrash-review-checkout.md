---
covers: ["pkg/skills-cli/src/thrash/**"]
---

[ADR 0042](../../docs/adr/0042-thrash-review-checkout.md)

- Never let `resolveCheckout` throw. Try cwd, clone, api, none in that order and stop at the first tree.
- Treat PR content as untrusted. Run every clone, fetch and checkout with `--no-tags`, `--no-recurse-submodules`, `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false` and `-c core.symlinks=false`.
- Run each git command that writes a work tree with `--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904`.
- Check the head SHA against `^[0-9a-f]{40}([0-9a-f]{24})?$` first and return `source: "none"` otherwise. Put `--end-of-options` before the SHA in `checkout` and `worktree add`.
- Give child processes an allowlisted environment with `GIT_LFS_SKIP_SMUDGE=1` and `GIT_TERMINAL_PROMPT=0`. Start each with `detached: true` and stop it with `killProcessTree` on timeout.
- Leave `credential.helper` as the user set it.
- Match the cwd origin with `git config --get remote.origin.url`, not `git remote get-url`.
- Never write to the cwd repository. Use `git clone --shared --no-checkout` into thrash scratch.
- Cover the cwd and clone steps with one `CLONE_TIMEOUT_MS` deadline of 120 s. On expiry, remove the partial tree and go to the api step.
- In the api step, use `Provider.getFileAtRef` for at most 50 text files. Skip unsafe paths and files above 1 MiB. Run at most 8 fetches at once.
- Never fail `thrash diff` on a checkout failure. Return `source: "none"` and let `thrash compile` note "Reviewed from the diff only".
- Read a local target (`thrash diff .`) in place with no clone and no git write command.
- Make `thrash stack --diff` clone once per repository and add one detached worktree per PR.
- Pass `--no-repo` to skip the checkout.
- Make `thrash post` delete only a tree whose `realpath` is inside `scratchDir("thrash")`, and only after a successful publish or in the dry-run branch.
