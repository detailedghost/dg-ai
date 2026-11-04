---
feature: "Recommended third-party plugins"
feature_snake_case: recommended_plugins
date: "2026-10-29"
version: "1.0"
status: draft
current_slice: 3
pr_strategy: single
slices:
  - id: 1
    name: "marketplace-pins-and-lint"
    depends_on: []
    files: [".claude-plugin/marketplace.json","THIRD_PARTY_NOTICES.md","scripts/bump-plugin-pin.ts","pkg/skills-test/__tests__/skill-manifests.spec.ts","pkg/skills-test/__tests__/imported-plugins-optional.spec.ts","pkg/skills-test/__tests__/plugin-pins.spec.ts","pkg/skills-test/__tests__/bump-plugin-pin.spec.ts","pkg/skills-test/__tests__/marketplace-support.ts"]
    agents:
      primary: js
      qa: [qa-code]
  - id: 2
    name: "install-with-recommended"
    depends_on: [1]
    files: ["pkg/skills-cli/src/install/recommended-plugins.ts","pkg/skills-cli/src/install/recommended-skills-only.ts","pkg/skills-cli/src/commands/install.ts","pkg/skills-cli/src/install/skills-only.ts","pkg/skills-cli/src/install/cli.ts","pkg/skills-cli/src/doctor/checks.ts","pkg/skills-cli/src/polish/doctor.ts","pkg/skills-cli/__tests__/install-recommended.spec.ts","pkg/skills-cli/__tests__/skills-only-recommended.spec.ts","pkg/skills-cli/__tests__/recommended-fixtures.ts","plugins/dg/skills/teach/**","plugins/dg/skills/wait-what/**","pkg/common/src/node/install-skills.ts","pkg/common/__tests__/install-skills.spec.ts","pkg/common/__tests__/installed-skill-files.ts","pkg/skills-cli/bootstrap.sh","pkg/skills-cli/bootstrap.ps1","pkg/skills-cli/__tests__/skills-only-install.spec.ts","pkg/skills-test/__tests__/skill-index-docs.spec.ts","pkg/skills-test/__tests__/retired-skills.spec.ts","plugins/dg/skills/README.md","README.md"]
    agents:
      primary: js
      qa: [security, qa-code]
  - id: 3
    name: "docs-adr-d"
    depends_on: [2]
    files: ["docs/install.md","docs/AGENT-INSTALL.md","docs/adr/0027-optional-third-party-plugins.md","docs/adr/toc.md","README.md","plugins/dg/skills/polish/references/pr.md","pkg/skills-test/__tests__/recommended-plugins-docs.spec.ts"]
    agents:
      primary: lore
      qa: [qa-code]
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Recommended third-party plugins

## Purpose
Treat imported third-party skills as optional extras that dg pins but does not maintain, with unslop and mattpocock/skills as the two examples. The marketplace is the single list; a bump script moves a pin; `dg-skills install --with-recommended` installs them for Claude Code through the plugin CLI and copies them for Codex and OpenCode through `--skills-only --dest`; a lint proves no dg skill requires any of them.

## Scope
### Included
- marketplace.json entry for mattpocock-skills pinned to a sha; unslop entry kept
- scripts/bump-plugin-pin.ts and the documented bump flow
- install --with-recommended for Claude Code (claude plugin CLI) and for skills-only destinations (git fetch at the pinned sha, copy declared skill dirs, skip name collisions)
- Lint: every mention of an imported plugin in plugins/dg carries the optional guard sentence
- THIRD_PARTY_NOTICES update, docs, ADR 0027, removal list for the user's private copies
- Retire dg's teach and wait-what skills in favor of mattpocock-skills (delete the skill dirs, RETIRED_SKILLS, bootstrap retired loops, docs and skill lists)
### Excluded
- Vendoring upstream skills into plugins/dg
- Automatic scheduled bumps (a manual script only)
- Retiring dg's grill-me or wayfinder copies (dg:spec and dg:grill-me link to /dg:wayfinder, and wayfinder runs dg:grill-me)

### Slice 1 — marketplace-pins-and-lint

#### Engineering
- [x] marketplace.json: add { name: 'mattpocock-skills', description, source: { source: 'github', repo: 'mattpocock/skills', ref: 'main', sha: 'a496f5513d4a4cf889bc48e189e579f4b0bdf6aa' } } with no skills key (the repo ships .claude-plugin/plugin.json listing 27 skills); keep unslop with skills ['./'] at sha 17ed39c9d0b522f44190ff0c6233867eadee192a (current main)
- [x] scripts/bump-plugin-pin.ts <name> [--ref r]: resolves the ref head through `git ls-remote https://github.com/<repo>.git <ref>`, rewrites the sha in marketplace.json, prints old -> new; exits 3 when the repo is unreachable and 1 for an unknown name
- [x] THIRD_PARTY_NOTICES.md: list the adapted dg files per upstream and state that the imported plugins are installed from upstream at the pinned sha; add grill-me only if the diff against upstream shows adaptation (teach and wait-what are retired in slice 2)
- [x] imported-plugins-optional.spec.ts: for each non-dg marketplace plugin P, every file under plugins/dg that mentions `/P:` or `P@detailedghost` must also match /is not installed, skip/i within the same file; `requires:` frontmatter never names P
- [x] plugin-pins.spec.ts: every non-dg marketplace entry has a 40-hex sha and a ref; the dg entry has source '.'

#### Testing Criteria
##### Contracts
- [x] Contract: imported-plugins-optional.spec.ts passes on the tree and fails when a fixture skill says `Run /unslop:unslop` without the guard sentence
- [x] Contract: plugin-pins.spec.ts fails when a sha is short or missing
- [x] bump script test: with a stubbed ls-remote output the file is rewritten and the diff is printed

#### Acceptance Criteria
- [x] Given `claude plugin marketplace add detailedghost/dg-ai`, when `claude plugin install mattpocock-skills@detailedghost` runs, then the 27 skills appear under /mattpocock-skills:
- [x] Given `bun scripts/bump-plugin-pin.ts mattpocock-skills`, when upstream moved, then marketplace.json carries the new sha and the test suite passes

### Slice 2 — install-with-recommended

#### Engineering
- [x] recommended-plugins.ts: recommendedPlugins() reads the embedded ../../../../.claude-plugin/marketplace.json (import with type json) and returns every entry whose name is not dg
- [x] installRecommendedForClaude(plugins, run): for each plugin compare installed_plugins.json gitCommitSha with the pinned sha; when absent run `claude plugin install <name>@detailedghost --json`; when different run uninstall then install; print one line per plugin; a missing claude binary or a failed command warns and continues
- [x] recommended-skills-only.ts: for each plugin: git init temp, `git fetch --depth 1 <url> <sha>`, `git checkout FETCH_HEAD`, assert `git rev-parse HEAD` equals the sha, read .claude-plugin/plugin.json skills or the entry's skills key, refuse symlinks (`git ls-files -s` mode 120000), copy each skill dir into <dest>/<skill-name> with installSkillTree semantics; a skill name that collides with a plugins/dg skill is skipped with `skipped <name> (dg ships its own)`; no network -> warn and continue
- [x] commands/install.ts: option `--with-recommended` ('also install the recommended third-party plugins from the marketplace: unslop, mattpocock-skills'); valid with the default, --cli-only and --skills-only modes
- [x] polish/doctor.ts unslopCheck fix text becomes `dg-skills install --with-recommended`
- [x] Retire dg's teach and wait-what: delete plugins/dg/skills/teach and plugins/dg/skills/wait-what; add both to RETIRED_SKILLS in pkg/common/src/node/install-skills.ts and to the retired loops in bootstrap.sh and bootstrap.ps1 (next to phone-friend); drop their entries from pkg/common/__tests__/installed-skill-files.ts and any test that counts skills

#### Testing Criteria
##### Contracts
- [x] Contract: installRecommendedForClaude with a fake runner installs a missing plugin and reinstalls one whose gitCommitSha differs; equal sha runs nothing
- [x] Contract: a fake runner that throws ENOENT (no claude) produces one warning and exit 0
- [x] Contract: skills-only path on a local bare repo fixture at a known sha copies the declared skills and skips `grill-me` and `wayfinder`, printing one skipped line each
- [x] Contract: a fixture whose HEAD does not equal the pinned sha aborts that plugin and copies nothing
- [x] Contract: a symlink inside a declared skill dir aborts that plugin
- [x] Contract: --with-recommended with --agent-only is rejected
- [x] install-recommended.spec.ts: one output line per plugin (no summary line)
- [x] retired-skills.spec.ts: a skills-only install into a dest that holds teach/ and wait-what/ removes both; plugins/dg/skills has neither directory; bootstrap.sh and bootstrap.ps1 name both in their retired loops

#### Acceptance Criteria
- [ ] Given a machine with the claude CLI, when `dg-skills install --cli-only --with-recommended` runs, then both plugins are installed at the pinned shas
- [ ] Given `dg-skills install --skills-only --dest ~/.codex/skills --with-recommended`, when it runs online, then ~/.codex/skills/unslop and the 25 non-colliding mattpocock skills exist and the 2 collisions (grill-me, wayfinder) are each printed
- [x] Given no network, when the same command runs, then dg skills install and each recommended plugin prints one warning
- [x] Given a user who had /dg:teach, when they update, then /dg:teach is gone and docs/install.md says /teach and /wait-what come from --with-recommended

### Slice 3 — docs-adr-d

#### Engineering
- [x] docs/install.md: Recommended plugins section (what, pin, bump, --with-recommended, Codex and OpenCode path, collisions, offline behavior, removal of private copies)
- [x] polish/references/pr.md install hint becomes `dg-skills install --with-recommended` while keeping the guard sentence
- [x] ADR 0027 and toc entry
- [x] plugins/dg/skills/README.md and README.md drop the teach and wait-what rows; docs/install.md says /teach and /wait-what now come from --with-recommended (mattpocock-skills)

#### Testing Criteria
##### Contracts
- [x] Contract: imported-plugins-optional.spec.ts still passes after the pr.md edit
- [ ] markdownlint and vale pass (markdownlint clean; vale not installed locally)

#### Acceptance Criteria
- [x] Given docs/install.md, when a user searches for unslop, then they find the install flag and the list of private copies to delete

## Slice Summaries

- Slice 3: docs/install.md Recommended plugins section, ADR 0027 (Proposed) with its toc link, the polish PR hint now says dg-skills install --with-recommended, and recommended-plugins-docs.spec.ts guards them.

- Slice 2: --with-recommended installs unslop and mattpocock-skills for Claude Code (claude plugin CLI, sha checked after install) and for --skills-only dests (fetch at the pinned sha, copy only regular tracked files of declared skill dirs with a SKILL.md, staged then swapped). teach and wait-what are retired; a retired folder is removed only when its SKILL.md hash matches a dg copy, in TS and both bootstraps. The two online acceptance items stay open until a manual run.

- Slice 1: mattpocock-skills is pinned in marketplace.json, scripts/bump-plugin-pin.ts moves a pin (exit 1 unknown name or bad ref, 2 missing file, 3 unreachable), and plugin-pins, imported-plugins-optional and bump-plugin-pin specs guard the pins and the optional guard sentence. The guard must sit on the same line as the plugin name. The lint scans all text files under plugins/dg.

## Agent Notes

- (orchestrator, slice 3) The Recommended plugins section in docs/install.md lists the old private copies to delete as generic paths: ~/.claude/skills/unslop, ~/.agents/skills/unslop and ~/.config/opencode/skills/unslop. No sizes and no machine-specific inventory. It names bump-plugin-pin, the grill-me and wayfinder skips, Codex and OpenCode via --skills-only --dest, and the offline behavior (one warning per plugin, dg skills still install).
- (orchestrator, slice 3) The orchestrator runs markdownlint and vale after the slice; no spec file for them.

- (orchestrator, slice 2) Dante chose: a skills install removes a retired teach or wait-what only when its SKILL.md sha256 is in RETIRED_SKILL_HASHES (pkg/common/src/node/install-skills.ts). bootstrap.sh and bootstrap.ps1 carry the same hashes. Fixtures of dg's last copies live in pkg/skills-test/__tests__/fixtures/retired-skills.

- (orchestrator, slice 2) Signatures follow the code sample: installRecommendedForClaude(plugins, home, run, log), run(argv) returns {status, stdout, stderr} with argv starting with "claude"; installRecommendedSkillsOnly(plugin, dest, dgSkillNames, log) returns the written paths. installed_plugins.json shape: plugins["<name>@detailedghost"] = [{ gitCommitSha }].
- (orchestrator, slice 2) installRecommendedSkillsOnly never throws. Offline, an unknown sha, a HEAD mismatch or a symlink each log exactly one line `⚠ <plugin> skipped: <reason>`, copy nothing for that plugin, and the install continues.
- (orchestrator, slice 2) No final summary line. One line per plugin only.
- (orchestrator, slice 2) --with-recommended with --agent-only exits 1 with an error that names both flags, and fetches or installs nothing.
- (orchestrator, slice 2) A skills entry of "./" (unslop) installs the repo root as <dest>/<plugin name>/ with no .git entries.
- (orchestrator, slice 2) Slice 2 removes the teach and wait-what rows from plugins/dg/skills/README.md and README.md when it deletes those skills, so skill-index-docs.spec.ts stays green. Slice 3 does the rest of the docs.
- (orchestrator, slice 2) Production git calls inherit the default environment (keep GIT_CONFIG_* so tests can redirect https://github.com/<repo>.git to a local bare repo).

- (orchestrator, slice 1) Keep pkg/skills-test/__tests__/marketplace-support.ts as the shared lint helper (pinViolations, optionalPluginViolations). The spec tests import it.
- (orchestrator, slice 1) bump-plugin-pin.spec.ts runs the script as a subprocess with cwd set to a temp dir that holds .claude-plugin/marketplace.json and a fake git first on PATH. Keep the script reading the relative path.
- (orchestrator, slice 1) The bump script does not print the upstream plugin.json version. It prints `<name>: <old> -> <new>` only.
- (orchestrator, slice 1) An unknown plugin name or a non-github entry prints an error to stderr and exits 1. Exit 3 means the repo is unreachable.
- (orchestrator, slice 1) The lint scans .md files under plugins/dg. The requires: check reads the frontmatter of any scanned .md file.

- (orchestrator) Run tests with TMPDIR=/home/detailedghost/.cache/dg-test-tmp. Tests never touch the real ~/.dg, ~/.claude, ~/.config, ~/.local or the keychain; use temp homes and fake runners. Never run the whole dg-daemon suite. Never run git stash in any form. Do not commit; the orchestrator commits. No inline code comments. American spelling. No network in tests: use local bare-repo fixtures and stubbed ls-remote output.

- (orchestrator) PR #135 (spec 007) merged first. It moved the install steps from commands/install.ts into pkg/skills-cli/src/install/cli.ts and the skills-only code into pkg/skills-cli/src/install/skills-only.ts. commands/install.ts is now a registrar that declares the options and loads install/cli.ts lazily. Slice 2 declares --with-recommended in commands/install.ts and wires the steps in install/cli.ts and install/skills-only.ts. Keep the commands/install.ts edit to the option line.
- (orchestrator) Spec 008 (per-OS layout) will also edit install-skills.ts, bootstrap.sh, bootstrap.ps1 and the skills-only specs. Keep those edits to the RETIRED_SKILLS list and the retired-skill loops so a rebase stays small.

## Issues Remediation

## Decisions

- [DECIDED] Imported third-party skills are optional extras dg pins but does not maintain. Anything a dg skill depends on today stays a dg-maintained copy in plugins/dg; no dg skill may require an imported plugin.
- [DECIDED] Opt-in install flag, off by default; works for Claude Code and, with `--skills-only --dest`, for Codex and OpenCode.
- [DECIDED] Flag name `--with-recommended` (fits `--cli-only`, `--agent-only`, `--skills-only`).
- [DECIDED] The marketplace is the single list: every `.claude-plugin/marketplace.json` entry whose name is not `dg` is a recommended plugin. No second list.
- [DECIDED] Flat Codex and OpenCode installs skip a skill whose name collides with a dg skill (`grill-me`, `wayfinder`) and print each skip; dg's copies win because dg:spec and dg:grill-me link to /dg:wayfinder and wayfinder runs dg:grill-me.
- Facts: unslop pin `17ed39c9d0b522f44190ff0c6233867eadee192a` is current `main` (2026-09-07), nothing to bump; mattpocock/skills `main` is `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa` (2026-10-29) and ships `.claude-plugin/plugin.json` (version 1.3.2, 27 skills), so the entry needs no `skills` key; unslop has `SKILL.md` at the repo root, hence `"skills": ["./"]`.
- Fact: Claude Code checks out the pinned `sha` on install; a sha change alone does not make `claude plugin update` act when the upstream `plugin.json` version is unchanged. The bump path for Claude is therefore uninstall + install, which `--with-recommended` does when `installed_plugins.json` `gitCommitSha` differs from the pin.
- [DECIDED] Keep `/dg:wayfinder` (adapted, dg-specific `dg-skills` calls) and `/dg:grill-me` (dg's own protocol used by `/dg:spec`) and the adapted `refactor/references/*`. Retire dg's `teach` and `wait-what` in this PR: `/teach` and `/wait-what` come from `--with-recommended` as `/mattpocock-skills:teach` and `/mattpocock-skills:wait-what`. Namespaces keep the two kept skills apart in Claude Code (`/dg:grill-me` vs `/mattpocock-skills:grill-me`).
- Token cost of installing mattpocock-skills: 27 more skill descriptions in every Claude session, about 1.5-2k tokens of system prompt. That is why it is opt-in.

## Code Structure

```text
.claude-plugin/marketplace.json                     + mattpocock-skills entry (pinned sha)
THIRD_PARTY_NOTICES.md                               per-upstream adapted files; imported plugins listed
scripts/bump-plugin-pin.ts                           <name> [--ref]: git ls-remote, rewrite sha, print diff
pkg/skills-cli/src/install/recommended-plugins.ts    recommendedPlugins() from the embedded marketplace.json; Claude path
pkg/skills-cli/src/install/recommended-skills-only.ts  git fetch at sha, verify, copy declared skills, skip collisions
pkg/skills-cli/src/commands/install.ts               --with-recommended option and wiring
pkg/skills-cli/src/polish/doctor.ts                  unslopCheck fix hint
pkg/skills-test/__tests__/imported-plugins-optional.spec.ts   guard-sentence lint
pkg/skills-test/__tests__/plugin-pins.spec.ts        sha and ref present on every non-dg entry
pkg/skills-cli/__tests__/install-recommended.spec.ts
pkg/skills-cli/__tests__/skills-only-recommended.spec.ts
docs/install.md                                      Recommended plugins section
docs/adr/0027-optional-third-party-plugins.md
```

## Code sample: the exact marketplace entry and the install path

`.claude-plugin/marketplace.json`:

```json
{
	"name": "detailedghost",
	"owner": { "name": "Dante Burgos" },
	"description": "detailedghost's personal Claude Code plugins.",
	"plugins": [
		{
			"name": "dg",
			"source": ".",
			"description": "DeeGee — detailedghost's personal Claude Code utilities."
		},
		{
			"name": "unslop",
			"description": "Remove AI writing patterns from prose.",
			"source": {
				"source": "github",
				"repo": "theclaymethod/unslop",
				"ref": "main",
				"sha": "17ed39c9d0b522f44190ff0c6233867eadee192a"
			},
			"skills": ["./"]
		},
		{
			"name": "mattpocock-skills",
			"description": "Matt Pocock's agent skills for real engineering: grilling, spec and ticket flows, TDD, code review, domain modeling.",
			"source": {
				"source": "github",
				"repo": "mattpocock/skills",
				"ref": "main",
				"sha": "a496f5513d4a4cf889bc48e189e579f4b0bdf6aa"
			}
		}
	]
}
```

`pkg/skills-cli/src/install/recommended-plugins.ts`:

```ts
import marketplace from "../../../../.claude-plugin/marketplace.json" with { type: "json" };

export type RecommendedPlugin = { name: string; repo: string; sha: string; skills?: string[] };

export function recommendedPlugins(): RecommendedPlugin[] {
	return marketplace.plugins
		.filter((p) => p.name !== "dg" && typeof p.source === "object")
		.map((p) => ({ name: p.name, repo: (p.source as { repo: string }).repo, sha: (p.source as { sha: string }).sha, skills: p.skills }));
}

type Runner = (argv: string[]) => { status: number | null; stdout: string; stderr: string };

export function installRecommendedForClaude(plugins: RecommendedPlugin[], home: string, run: Runner, log: (line: string) => void): void {
	const installed = readInstalledPlugins(home);
	for (const plugin of plugins) {
		const ref = `${plugin.name}@detailedghost`;
		const current = installed.get(ref)?.gitCommitSha;
		if (current === plugin.sha) {
			log(`${plugin.name} already at ${plugin.sha.slice(0, 7)}.`);
			continue;
		}
		const steps = current ? [["plugin", "uninstall", ref], ["plugin", "install", ref, "--json"]] : [["plugin", "install", ref, "--json"]];
		const failed = steps.map((args) => run(["claude", ...args])).find((r) => r.status !== 0);
		if (failed) log(`⚠ ${plugin.name} skipped: ${failed.stderr.trim() || `exit ${failed.status}`}`);
		else log(`${plugin.name} ${current ? "updated to" : "installed at"} ${plugin.sha.slice(0, 7)}.`);
	}
}
```

`pkg/skills-cli/src/install/recommended-skills-only.ts`:

```ts
export function installRecommendedSkillsOnly(plugin: RecommendedPlugin, dest: string, dgSkillNames: Set<string>, log: (line: string) => void): string[] {
	const checkout = mkdtempSync(join(tmpdir(), `dg-plugin-${plugin.name}-`));
	try {
		git(["init", "-q"], checkout);
		git(["fetch", "-q", "--depth", "1", `https://github.com/${plugin.repo}.git`, plugin.sha], checkout);
		git(["checkout", "-q", "FETCH_HEAD"], checkout);
		const head = git(["rev-parse", "HEAD"], checkout).trim();
		if (head !== plugin.sha) throw new Error(`${plugin.name}: fetched ${head}, expected ${plugin.sha}`);
		if (git(["ls-files", "-s"], checkout).split("\n").some((line) => line.startsWith("120000 "))) throw new Error(`${plugin.name}: refuses a repository with symlinks`);
		const skillDirs = plugin.skills ?? readPluginManifestSkills(checkout);
		const written: string[] = [];
		for (const dir of skillDirs) {
			const source = resolve(checkout, dir);
			const name = basename(source) === checkout ? plugin.name : basename(source);
			if (dgSkillNames.has(name)) {
				log(`skipped ${name} (dg ships its own)`);
				continue;
			}
			written.push(...copySkillDir(source, join(dest, name)));
		}
		return written;
	} finally {
		rmSync(checkout, { recursive: true, force: true });
	}
}
```

Offline or unreachable: `git fetch` fails, the error is printed as `⚠ <plugin> skipped: <reason>` and the install continues; the dg skills are already copied by then. The Claude path behaves the same when `claude` is missing or exits non-zero.

Call sites in `commands/install.ts`: after `installCliOnly`/`installCli`/`installPinnedAll` finish, `if (opts.withRecommended) installRecommendedForClaude(recommendedPlugins(), homedir(), runSync, console.log)`; in the `--skills-only` branch, after `runSkillsOnlyInstall`, `for (const p of recommendedPlugins()) installRecommendedSkillsOnly(p, result.dest, new Set(skillDirectoryNames(result.files)), console.log)`.

`scripts/bump-plugin-pin.ts`:

```ts
const [name, refFlag, refValue] = Bun.argv.slice(2);
const file = ".claude-plugin/marketplace.json";
const doc = JSON.parse(readFileSync(file, "utf8"));
const entry = doc.plugins.find((p) => p.name === name && typeof p.source === "object");
if (!entry) throw new Error(`no github plugin named ${name} in ${file}`);
const ref = refFlag === "--ref" && refValue ? refValue : entry.source.ref;
const out = Bun.spawnSync(["git", "ls-remote", `https://github.com/${entry.source.repo}.git`, ref], { stdout: "pipe", stderr: "pipe" });
if (out.exitCode !== 0) process.exit(3);
const sha = out.stdout.toString().split(/\s/)[0];
console.log(`${name}: ${entry.source.sha} -> ${sha}`);
entry.source.sha = sha;
writeFileSync(file, `${JSON.stringify(doc, null, "\t")}\n`);
```

Lint `pkg/skills-test/__tests__/imported-plugins-optional.spec.ts`: for each recommended plugin `P`, scan every `.md` under `plugins/dg`; a file that contains `/P:` or `P@detailedghost` must also match `/is not installed, skip/i`; no `SKILL.md` frontmatter `requires:` names `P`. Today `polish/references/pr.md` passes (it says "When the `/unslop:unslop` skill is not installed, skip this step").

## Who bumps a pin, and how

The repo owner runs `bun scripts/bump-plugin-pin.ts mattpocock-skills` (or `unslop`), reviews the upstream diff, runs `bun test` (pins and lint), and merges. Users get the new pin on their next `dg-skills install --with-recommended`: Claude Code through uninstall + install when `gitCommitSha` differs; Codex and OpenCode through a fresh fetch at the sha. No scheduled job.

## Private copies the user can delete after the switch

- `~/.claude/skills/unslop` (3.6 MB), `~/.agents/skills/unslop` (3.6 MB), `~/.config/opencode/skills/unslop` (3.6 MB). `~/.copilot/skills` is a symlink to `~/.claude/skills`, so it needs no step.
- `~/.codex/skills` has no unslop copy today; `dg-skills install --skills-only --dest ~/.codex/skills --with-recommended` adds one.
- Then: `claude plugin install unslop@detailedghost` or `dg-skills install --with-recommended`.

## Size, speed and token impact

Size: the embedded marketplace.json adds under 1 KB; the install chunk grows about 4 KB. Speed: nothing at startup; `--with-recommended` runs `claude` or `git` once per plugin. Tokens: opt-in only; mattpocock-skills adds about 1.5-2k tokens per Claude session when installed.

## Risks and early signals

- GitHub may reject `fetch <sha>` for an unadvertised commit on some repos; both upstreams allow it today (tested pattern used by Claude Code itself); fallback is `--depth 1 --branch <ref>` then `checkout <sha>`.
- Upstream renames a skill directory to a dg name: the collision rule skips it and prints the line.

## ADR draft: docs/adr/0027-optional-third-party-plugins.md

Status: Proposed. Context: dg adapts some upstream skills (THIRD_PARTY_NOTICES.md) and the user kept private copies of others in four places; the marketplace already imported unslop at a pinned sha. Decision: third-party skills are imported as marketplace plugins pinned to a sha, installed only with `--with-recommended`, and never required by a dg skill; a lint enforces the guard sentence on every mention; a script moves pins. Consequences: good — one list, reproducible pins, no private copies; bad — flat installs lose namespacing so colliding names are skipped; neutral — dg keeps its adapted grill-me, wayfinder and refactor references and retires teach and wait-what. Alternatives: vendor upstream into plugins/dg (maintenance), require the plugins (breaks skills-only users offline).

## Ratified decisions

- [DECIDED] The flag is `--with-recommended`.
- [DECIDED] Flat installs (Codex, OpenCode) skip a name collision and print each skip; collisions are grill-me and wayfinder.
- [DECIDED] (changed from the first draft) Keep dg's grill-me and wayfinder; retire dg's `teach` and `wait-what` in favor of mattpocock-skills, with the removal work in slices 2 and 3.

## Chain position

Layer 4 on `feat/install-prune-plugin-cache` (both add install flags and edit `commands/install.ts`). Branch `chore/recommended-plugins`. Independent of A.
