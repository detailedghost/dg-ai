# Slice 10 — distribution-skill-and-ci

Per-slice review findings (plan.md step 5). Verified against the real files listed
under each finding — see plan.md's Code Structure section for the cross-slice
decisions this slice must honor.

1. [OPEN — escalate] **No protocol-version signal exists anywhere in the frame
   contract, for a world where three independently-released artifacts speak it.**
   Verified `pkg/common/src/proto-format.ts` has zero references to "version" —
   there is no existing handshake/compat convention to reuse, and slice 1's
   `chat-format.ts` scope (plan.md lines 124-133) defines no `protocolVersion`
   field on `ChatFrame` or a dedicated handshake frame. Yet after slice 10,
   `dg-skills` (`skills-v*`), `dg-server` (`server-v*`), and the extension
   (`ext-v*`) are three separately-tagged, separately-versioned release
   artifacts all speaking one wire format — and `install.ts` already refreshes
   each independently, skipping whichever is "already current" per binary
   (`installCli()`'s `versionGte` check). A user can end up on a stale `dg-server`
   with a fresh extension, or vice versa, with nothing surfacing that mismatch
   beyond `validateChatFrame` throwing on an unrecognized discriminant (a
   validation error, not a "please upgrade X" message).
   Options: (a) add a minimal `protocolVersion` field to `ChatFrame` plus a
   handshake check the daemon/page enforce on connect — belongs in slice 1, not
   10, since slice 10 only documents/distributes, it doesn't touch
   `chat-format.ts`; (b) accept `validateChatFrame`'s throw as the only signal
   and document the failure mode in the chat SKILL.md/docs; (c) defer as an
   accepted bundle-1 risk since all three artifacts currently ship from one
   monorepo commit. I can't fix this from slice 10's file list (`chat-format.ts`
   isn't in it) — surfacing for whoever owns slice 1/the plan.

2. [CI path filters] **Verified**: `pkg/common/**` already triggers both
   `skills-blt.yml` (PR) and `skills-release.yml` (push→master, tag
   `skills-v${skills-cli version}`). Adding `dg-server-blt.yml`/
   `dg-server-release.yml` path-filtered to `pkg/dg-server/**` + `pkg/common/**`
   means a common-only change now also fires the dg-server pair — this is
   consistent with the existing skills pipeline's behavior, not a new failure
   mode. Tag collision risk: none — `skills-v*`, `server-v*`, `ext-v*` are
   disjoint prefixes, each release job creates its own tag/release object
   (`gh release create "$tag" ...`), and each is gated by its own package's
   independent `package.json` version, so two workflows firing off the same
   push never contend over the same tag or release. One asymmetry worth noting
   (pre-existing, not slice 10's to fix): `ext-blt.yml` (PR) filters on
   `pkg/common/**` but `ext-release.yml` (push) does **not** — a common-only
   change never re-cuts the extension release today. When building
   `dg-server-release.yml`, mirror `skills-release.yml`'s filter (include
   `pkg/common/**` in the push trigger), not `ext-release.yml`'s narrower one.

3. [Manual step — branch protection] `docs/DEVELOPER.md:79` states "PRs to
   `master` require both `ext-blt` and `skills-blt` to pass" — that's a GitHub
   repo **Branch Protection** required-status-checks setting, not something the
   workflow YAML itself declares. Adding `dg-server-blt.yml` does not
   automatically make it blocking; a human with repo-admin must add
   `dg-server-blt` to the required checks list, or a broken dg-server build can
   merge silently. Call this out explicitly as a manual post-merge step, and
   update `docs/DEVELOPER.md`'s Branch Protection line and CI Overview table
   (lines 68-79) to list the new workflow and its trigger paths.

4. [Fetcher generalization — scope correction] The plan's bullet names
   `resolveCliAsset`/`fetchCliBinary`/`versionGte` for generalization, but
   `versionGte(a, b)` (`pkg/skills-cli/src/utils/lib.ts:152`) is already fully
   binary-agnostic — pure version-string comparison, no hardcoded name or tag
   prefix. It needs no change. The functions that actually hardcode
   `"dg-skills"`/`"skills-v"` and must be parameterized are `cliAssetName`,
   `pickCliAsset`, `resolveCliAsset`, `fetchCliBinary`, `cliDest`, and
   `cliVersionFile` — all six live in `pkg/skills-cli/src/utils/lib.ts`, not
   `install.ts` (`install.ts` only calls them). Recommend the implementing
   engineer work from this verified list rather than the plan's abbreviated
   one, to avoid either missing a hardcoded function or needlessly touching
   `versionGte`.

5. [Fetcher generalization — param shape] Take `binaryName` and `tagPrefix` as
   two explicit parameters (as the plan says), not one derived from the other.
   The only two data points today — `dg-skills`→`skills-v`, `dg-server`→
   `server-v` — both happen to follow "drop the `dg-` prefix, append `-v`", but
   inferring a derivation rule from two examples is exactly the kind of
   premature-clever shortcut that breaks the next binary that doesn't fit the
   pattern. Keep it boring: two explicit strings in, no regex-derivation.

6. [Structure conformance — test file placement] Slice 10's file list names a
   new `pkg/skills-cli/__tests__/install.spec.ts`, but **no such file exists
   today**, and the established, already-wired home for exactly this coverage
   is `pkg/skills-test/__tests__/install-logic.spec.ts` — a dedicated sibling
   package (`@dg/skills-test`, described in its own `package.json` as "the
   install logic resolves the right release assets") that already unit-tests
   `cliAssetName`/`pickCliAsset`/`pickExtAsset` imported via the
   `@dg/skills-cli/lib` subpath export, and is already run by
   `skills-blt.yml`'s "Test (skills-test — install logic + skill manifests +
   CLI smoke)" step. Creating a second, differently-located file with
   overlapping purpose duplicates this rather than reusing it. Recommend:
   extend `pkg/skills-test/__tests__/install-logic.spec.ts` with the
   dg-server-asset cases instead, and add `pkg/skills-test/**` to slice 10's
   `files` list (currently absent).

7. [Risk — cross-skill test gap] `pkg/skills-test/__tests__/skill-manifests.spec.ts`'s
   "CLI-invoking SKILL.md uses the compiled binary" block (lines 108-130) loops
   every skill directory but gates its four assertions on
   `if (!md.includes("dg-skills")) continue` — a hardcoded single-binary
   assumption. This file is **not** in slice 10's file list, yet it directly
   bears on the plan's own acceptance criterion ("SKILL.md's documented
   commands and flags match the CLI's actual surface"). Two ways this breaks:
   (a) if `chat/SKILL.md` mentions "dg-skills" anywhere (likely, since it
   bootstraps transitively via `dg-skills install`), the block wrongly demands
   it "invokes `~/.dg/bin/dg-skills`" even though the chat skill's actual
   command surface — `recv`/`send`/`status`/`spawn` — is `dg-server`
   (`pkg/dg-server/src/commands/**`, slice 7); (b) if the SKILL.md avoids that
   substring, the block is skipped entirely and the new skill gets **zero**
   parity coverage. Recommend adding `pkg/skills-test/**` to slice 10's files
   and extending this describe block with a parallel `dg-server`-gated branch
   (own bin path, own bootstrap-script assertions).

8. [Skill correctness — bootstrap gate targets the wrong binary if copied
   verbatim] `browser/SKILL.md`, `demo/SKILL.md`, and `docs/AGENT-INSTALL.md`
   all gate their bootstrap-then-invoke snippet on
   `DG="$HOME/.dg/bin/dg-skills"; if [ ! -x "$DG" ]; then …bootstrap…; fi`.
   Copying this shape verbatim for `chat/SKILL.md` (as instructed, "following
   the browser skill's bootstrap-then-invoke shape") would gate on the **wrong**
   binary: a machine that already used the browser/demo/proto skills has
   `dg-skills` on disk, so the copied gate short-circuits and bootstrap never
   runs — even though `dg-server`, the binary chat's `recv`/`send`/`status`/
   `spawn` loop actually calls, has never been fetched. `chat/SKILL.md`'s gate
   must check for `~/.dg/bin/dg-server` (`.exe` on Windows) specifically, even
   though the same `bootstrap.sh`/`bootstrap.ps1` script fills both binaries.

9. [Bootstrap scope — recommend simplification, not new fetch code]
   "Extend `bootstrap.sh` and `bootstrap.ps1` to install both binaries" risks
   being built as a second hand-rolled curl/`Invoke-WebRequest` fetch loop for
   `dg-server`, tripling the same fetch-with-fallback logic across bash,
   PowerShell, and (already-generalized) TS. That duplication is unnecessary:
   unlike `dg-skills`, `dg-server` has no chicken-and-egg problem — nothing
   needs `dg-server` to already exist in order to fetch it. `bootstrap.sh`
   already ends with `"${DEST}" install` (line 63); once `install.ts`'s CLI-
   refresh step is generalized to also fetch `dg-server`, that existing tail
   call covers it for free. This also resolves the "what happens when a
   dg-server asset doesn't exist for a platform" question cleanly:
   `bootstrap.sh`'s own curl loop today hard-`exit 1`s when its one asset is
   missing (lines 42-45), whereas `installCli()` in `install.ts` is
   deliberately best-effort — "warn, never throw" per its own doc comment.
   Reusing bootstrap.sh's hard-fail pattern for a second, newer binary that may
   not yet be built for every platform risks aborting the *entire* bootstrap
   (including the still-good dg-skills+extension install) over a missing
   dg-server asset alone. Routing dg-server exclusively through the
   already-correct warn-and-continue `install` path avoids that regression.
   Recommend: verify the existing tail call satisfies "install both binaries"
   before writing any new fetch code in these two files.

10. [OPEN — escalate] **The CI/workflow half of this slice does not need all
    nine dependencies; the skill/docs half arguably does.** The engineering
    bullets split into two groups with very different real prerequisites:
    (a) `dg-server-blt.yml`/`dg-server-release.yml`, the fetcher
    generalization, and the bootstrap-script changes need only
    `pkg/dg-server` to exist as a buildable/testable package — i.e., slice 2
    (dg-server-skeleton) alone, since `dg-server-blt.yml` just runs `bun test`/
    `bun run lint`/`bun run build` in that package; (b) `chat/SKILL.md`'s
    documented `recv`/`send`/`status`/`spawn` loop, its manifest-format
    description, and the `.agents/monolith.md` vocabulary genuinely need the
    full CLI surface (slices 7, 8) and the canvas (slice 6) to be true when
    written. As sequenced, slices 2 through 9 each carry their own "bun run
    --filter test/lint pass" acceptance criterion but **none of them get a CI
    gate until slice 10 lands** — eight slices' worth of engineering relying on
    ad-hoc local test runs instead of an enforced pipeline, which is exactly
    the "broken release pipeline discovered late" risk the task called out.
    Options: (i) leave as-is and accept the late-discovery risk, since the
    workflow YAML itself is small and mechanical; (ii) split into 10a
    (CI/workflow/fetcher/bootstrap, `depends_on: [1,2]`) landed right after the
    skeleton, and 10b (skill docs/vocabulary, `depends_on: [1..9]`) at the end;
    (iii) minimally, add a stub `dg-server-blt.yml` depending only on slice 2,
    amended later if the matrix changes. This changes plan.md's slice graph,
    which I'm not permitted to edit — surfacing for the plan owner to decide.

11. [Verified — no change needed] `.claude-plugin/plugin.json`'s `skills`
    field is `["./plugins/dg/skills"]` and `.codex-plugin/plugin.json`'s is
    `"./skills/"` — both are directory pointers, not enumerated skill lists,
    and `pkg/skills-test/__tests__/skill-manifests.spec.ts` pins these exact
    values in its own tests. Adding `plugins/dg/skills/chat/` needs no change
    to either manifest. Non-blocking, pre-existing staleness (not caused by
    slice 10): `.claude-plugin/plugin.json`'s `keywords` array
    (`["utilities","browser","tabs","demo"]`) and `.codex-plugin/plugin.json`'s
    `shortDescription`/`longDescription`/`defaultPrompt` already omit `demo`
    inconsistently and will drift further once `chat` exists — optional
    cleanup, not required by this slice.

12. [Docs vocabulary — schema fit confirmed] `.agents/monolith.md`'s Domain
    Terms table (`**Term** | Definition (avoid: X, Y) _src:_ path`) fits the
    requested additions (dg-server, ChatFrame, chat node, session handle)
    cleanly, matching the shape of existing entries like `SkillsCLI` and
    `CommonPackage`. Since slice 10 only *writes* `monolith.md` and never
    touches the cited source files, these new entries' `_src:` pointers will
    cite slice 1/2/6 files (`chat-format.ts`, dg-server's session registry,
    `chat-node.ts`) — that's consistent with slice 10 running last, after all
    cited code exists. No naming collision found against existing terms or
    `(avoid: …)` lists.

13. [Docs — routine extension, low risk] `docs/DEVELOPER.md`'s CI Overview
    table (lines 70-79) and `README.md`'s install section already establish
    the row/prose shape slice 10 needs to extend. Flagging only that
    `docs/AGENT-INSTALL.md`'s "what an agent can/cannot automate" table
    (line 137: `` `dg-skills install` (stage extension) | Yes ``) and its
    Step 3 `--help` verification list should explicitly grow to mention
    `dg-server`/`dg:start`, or the matrix goes stale the moment this slice
    ships.

14. [Testing convention — carry forward] `.agents/school/quality.md`'s
    2026-07-29 entry documents that `skill-manifests.spec.ts`'s prose
    assertions are fragile to markdown soft-wrap alone. Any new `toContain`
    assertions added for `chat/SKILL.md` (per finding 7) should prefer
    `toMatch(/word1\s+word2/)` for multi-word phrases and reserve exact
    `toContain` for short single-line phrases, matching the established fix
    for this exact failure mode.
