import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statePath, uniqueName } from "@dg/common/node";
import { baseBranch, currentBranch, git, isDirty, resolveBaseSha } from "../utils/git";
import { emitJson } from "../utils/json";
import { defineCommand, die, EXIT } from "../utils/legacy-command";

// --- command ---------------------------------------------------------------

const cmd = defineCommand({
	name: "meaningful",
	description: "Git plumbing for the /meaningful skill.",
	subcommands: {
		info: {
			description: "Print branch info as JSON",
			run: cmdInfo,
		},
		apply: {
			description: "Soft-reset to base and recommit groups from a text plan file",
			args: ["[--base <ref>]", "plan-file"],
			run: cmdApply,
		},
		"apply-json": {
			description: "Soft-reset to base and recommit groups from a JSON plan file",
			args: ["[--base <ref>]", "plan-file"],
			run: cmdApplyJson,
		},
		abort: {
			description: "Hard-reset to backup ref (undo apply, no push)",
			args: ["backup-ref"],
			run: cmdAbort,
		},
	},
});

/** Run the meaningful parser only when explicitly invoked with command arguments. */
export async function main(argv: string[]): Promise<void> {
	await cmd.run(argv);
}

// --- subcommands -----------------------------------------------------------

/** Extract --base <ref> from args array; returns [ref|undefined, remaining]. */
function extractBase(args: string[]): [string | undefined, string[]] {
	const idx = args.indexOf("--base");
	if (idx === -1) return [undefined, args];
	const ref = args[idx + 1];
	if (!ref || ref.startsWith("-")) die("--base requires a ref argument", EXIT.USAGE);
	const rest = args.filter((_, i) => i !== idx && i !== idx + 1);
	return [ref, rest];
}

async function cmdInfo(args: string[]): Promise<void> {
	const [baseOverride] = extractBase(args);

	const branch = await currentBranch();
	if (branch === "HEAD") die("detached HEAD; checkout a branch first.", EXIT.ERR);

	const base = await baseBranch();

	let upstream = "";
	try {
		upstream = (await git`rev-parse --abbrev-ref --symbolic-full-name @{u}`).text().trim();
	} catch {
		// no upstream configured
	}

	let baseSha = "";
	try {
		baseSha = await resolveBaseSha(baseOverride);
	} catch {
		die(`cannot find merge-base with ${baseOverride ?? base}.`, EXIT.ERR);
	}

	const range = `${baseSha}..HEAD`;
	const headSha = (await git`rev-parse HEAD`).text().trim();
	const ahead = Number((await git`rev-list --count ${range}`).text().trim());

	// %H = sha, %aN = author name (respects .mailmap), %s = subject
	const commitsRaw = (await git`log --reverse --format=%H%x09%aN%x09%s ${range}`).text().trim();
	const commits =
		commitsRaw.length === 0
			? []
			: commitsRaw.split("\n").map((line) => {
					const parts = line.split("\t");
					return {
						sha: parts[0],
						author: parts[1],
						subject: parts.slice(2).join("\t"),
					};
				});

	// Renames disabled: a rename appears as both old path (deleted) and new path (added).
	const filesRaw = (await git`-c diff.renames=false diff --name-only ${range}`).text().trim();
	const files = filesRaw.length === 0 ? [] : filesRaw.split("\n");

	// file_authors: file → distinct human author names across the range (AI authors excluded).
	const fileAuthors: Record<string, string[]> = {};
	for (const { sha, author } of commits) {
		if (/claude/i.test(author)) continue;
		const touched = (await git`-c diff.renames=false diff-tree --no-commit-id -r --name-only ${sha}`).text().trim();
		for (const f of touched.split("\n").filter(Boolean)) {
			if (!fileAuthors[f]) fileAuthors[f] = [];
			if (!fileAuthors[f].includes(author)) fileAuthors[f].push(author);
		}
	}

	emitJson({
		branch,
		base_branch: base,
		base_sha: baseSha,
		head_sha: headSha,
		upstream,
		ahead,
		commits,
		files,
		file_authors: fileAuthors,
	});
}

async function cmdApply(args: string[]): Promise<void> {
	const [baseOverride, rest] = extractBase(args);
	const planFile = rest[0];
	if (!planFile) die("usage: apply [--base <ref>] <plan-file>", EXIT.USAGE);

	let planText = "";
	try {
		planText = readFileSync(planFile, "utf8");
	} catch {
		die(`plan file not found: ${planFile}`, EXIT.ERR);
	}

	const ctx = await preflightAndCapture(baseOverride);

	const groups = parsePlan(planText);
	if (groups.length === 0) die("no groups parsed from plan.", EXIT.ERR);

	await assertFilesMatchDiff(ctx.baseSha, groups);
	await reshapeAndPush(groups, ctx);

	process.stdout.write(`${ctx.backup}\n`);
}

async function cmdApplyJson(args: string[]): Promise<void> {
	const [baseOverride, rest] = extractBase(args);
	const planFile = rest[0];
	if (!planFile) die("usage: apply-json [--base <ref>] <plan-file>", EXIT.USAGE);

	let planText = "";
	try {
		planText = readFileSync(planFile, "utf8");
	} catch {
		die(`plan file not found: ${planFile}`, EXIT.ERR);
	}

	const { base: planBase, groups } = parseJsonPlan(planText);

	const ctx = await preflightAndCapture(baseOverride ?? planBase);

	await assertFilesMatchDiff(ctx.baseSha, groups);
	await reshapeAndPush(groups, ctx);

	process.stdout.write(`${ctx.backup}\n`);
}

async function cmdAbort(args: string[]): Promise<void> {
	const ref = args[0];
	if (!ref) die("usage: abort <backup-ref>", EXIT.USAGE);
	await git`reset --hard ${ref}`;
}

// --- shared reshape pipeline (apply + apply-json) ---------------------------

interface ReshapeContext {
	branch: string;
	baseSha: string;
	backup: string;
	origTree: string;
}

/** Dirty-tree refusal, detached-HEAD refusal, base resolution, and backup/tree
 * capture — the preflight steps both apply commands share before touching
 * anything destructive. */
async function preflightAndCapture(baseOverride?: string): Promise<ReshapeContext> {
	if (await isDirty()) die("working tree has uncommitted changes; stash or commit first.", EXIT.ERR);

	const branch = await currentBranch();
	if (branch === "HEAD") die("detached HEAD.", EXIT.ERR);

	let baseSha = "";
	try {
		baseSha = await resolveBaseSha(baseOverride);
	} catch {
		die(`cannot resolve base ref.`, EXIT.ERR);
	}

	const backup = (await git`rev-parse HEAD`).text().trim();
	// Capture pre-reshape tree for the integrity check before push.
	const origTree = (await git`rev-parse HEAD^{tree}`).text().trim();

	process.stderr.write(`meaningful: backup ref = ${backup}\n`);

	return { branch, baseSha, backup, origTree };
}

/** Validate that the union of plan-group files equals the diff from base
 * (rename detection disabled — see the File-Set Convention doc). */
async function assertFilesMatchDiff(baseSha: string, groups: Group[]): Promise<void> {
	const range = `${baseSha}..HEAD`;
	const expectedRaw = (await git`-c diff.renames=false diff --name-only ${range}`).text().trim();
	const expected = new Set(
		expectedRaw.length === 0
			? []
			: expectedRaw
					.split("\n")
					.map((f) => f.trim())
					.filter(Boolean),
	);
	const actual = new Set(groups.flatMap((gr) => gr.files));

	if (!setsEqual(expected, actual)) {
		process.stderr.write(`error: plan files do not match diff from ${baseSha}.\n`);
		process.stderr.write(`expected files:\n${[...expected].sort().join("\n")}\n`);
		process.stderr.write(`got files:\n${[...actual].sort().join("\n")}\n`);
		die("plan/diff mismatch.", EXIT.ERR);
	}
}

/** Prefix a path with git's literal pathspec magic so glob-looking characters
 * in real filenames (e.g. the brackets in `entity/[entityId]/merge`) match
 * literally instead of being parsed as an fnmatch pattern. Without this,
 * `git add -- <bracketed path>` silently stages nothing and the tree-equality
 * guard trips. */
function literalPathspec(file: string): string {
	return `:(literal)${file}`;
}

/** Soft-reset to base, recommit each group, run the tree-equality guard, and
 * push. Shared by apply and apply-json — the only difference between the two
 * commands is how `groups` gets built from their respective plan formats. */
async function reshapeAndPush(groups: Group[], ctx: ReshapeContext): Promise<void> {
	const workdir = statePath("meaningful", uniqueName("meaningful"));
	mkdirSync(workdir, { recursive: true });
	try {
		await git`reset --soft ${ctx.baseSha}`;

		const unstage = async () => {
			try {
				await git`restore --staged .`;
			} catch {
				await git`reset HEAD -- .`;
			}
		};

		await unstage();

		for (let i = 0; i < groups.length; i++) {
			const group = groups[i];
			const msgFile = path.join(workdir, `g${String(i).padStart(3, "0")}.msg`);
			writeFileSync(msgFile, group.msg);

			await unstage();

			if (group.files.length > 0) {
				await git`add -- ${group.files.map(literalPathspec)}`;
			}

			const staged = (await git`diff --cached --name-only`).text().trim();
			if (!staged) {
				process.stderr.write(`error: group ${i + 1} has no staged changes; aborting.\n`);
				process.stderr.write(`Restore with: git reset --hard ${ctx.backup}\n`);
				die("empty group; aborting.", EXIT.VALIDATION);
			}

			if (group.author) {
				await git`commit -F ${msgFile} --author=${group.author}`;
			} else {
				await git`commit -F ${msgFile}`;
			}
			process.stderr.write(`meaningful: committed group ${i + 1}\n`);
		}

		// Tree-equality guard: reshaped commits must produce an identical tree.
		const dirty = (await git`status --porcelain`).text().trim();
		const reshapedTree = (await git`rev-parse HEAD^{tree}`).text().trim();
		if (dirty || reshapedTree !== ctx.origTree) {
			await git`reset --hard ${ctx.backup}`;
			die(
				`tree mismatch after reshape (backup restored: ${ctx.backup}). ` +
					`origTree=${ctx.origTree} reshapedTree=${reshapedTree}`,
				EXIT.ERR,
			);
		}

		// Force-push-with-lease if upstream exists, otherwise set and push
		let hasUpstream = false;
		try {
			await git`rev-parse --abbrev-ref @{u}`;
			hasUpstream = true;
		} catch {
			// no upstream
		}

		if (hasUpstream) {
			process.stderr.write("meaningful: force-push-with-lease...\n");
			await git`push --force-with-lease`;
		} else {
			process.stderr.write("meaningful: no upstream; setting and pushing.\n");
			await git`push -u origin ${ctx.branch}`;
		}
	} finally {
		rmSync(workdir, { recursive: true, force: true });
	}
}

// --- plan parsing (text) -----------------------------------------------------

/** Strip Co-Authored-By trailers whose name contains "claude" or email is noreply@anthropic.com. */
function stripClaudeTrailers(msg: string): string {
	return msg
		.split("\n")
		.filter((l) => {
			const m = l.match(/^Co-Authored-By:\s*(.+?)\s*<([^>]+)>/i);
			if (!m) return true;
			return !/claude/i.test(m[1]) && m[2] !== "noreply@anthropic.com";
		})
		.join("\n")
		.trimEnd();
}

/** Validate an inline "Name <email>" string shared by AUTHOR lines (text plan)
 * and author/coauthors fields (JSON plan); dies with a consistent message. */
function validateAuthorFormat(val: string, context: string): void {
	if (!/^[^<]+ <[^>]+>/.test(val)) die(`malformed ${context}: "${val}" — expected: Name <email>`, EXIT.USAGE);
}

interface Group {
	msg: string;
	author?: string;
	files: string[];
}

function parsePlan(text: string): Group[] {
	const groups: Group[] = [];
	let current: Group | null = null;
	let mode: "msg" | "files" | "none" = "none";

	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();

		if (line.startsWith("MSG:")) {
			current = { msg: line.slice(4).trimStart(), files: [] };
			groups.push(current);
			mode = "msg";
			continue;
		}

		if (line.startsWith("AUTHOR:") && current) {
			const val = line.slice(7).trim();
			validateAuthorFormat(val, "AUTHOR line");
			current.author = val;
			continue;
		}

		if (line.startsWith("FILES:")) {
			mode = "files";
			continue;
		}

		if (line.trim() === "") {
			mode = "none";
			continue;
		}

		if (!current) continue;

		if (mode === "msg") {
			current.msg += `\n${line}`;
		} else if (mode === "files") {
			const f = line.trim();
			if (f) current.files.push(f);
		}
	}

	for (const gr of groups) gr.msg = stripClaudeTrailers(gr.msg.trim());
	return groups.filter((gr) => gr.files.length > 0);
}

// --- plan parsing (JSON) -----------------------------------------------------

interface JsonGroup {
	subject: string;
	body?: string;
	author?: string;
	coauthors?: string[];
	files: string[];
}

interface JsonPlan {
	base?: string;
	groups: JsonGroup[];
}

/** Parse a JSON plan into the same Group[] shape the text parser produces.
 * Subject/body are joined with an explicit blank line and coauthor trailers
 * are appended as their own paragraph — no shared "mode" state, so this path
 * never hits parsePlan()'s blank-line/body-glue bug. */
function parseJsonPlan(text: string): { base?: string; groups: Group[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		die(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`, EXIT.USAGE);
	}

	if (typeof raw !== "object" || raw === null || !Array.isArray((raw as JsonPlan).groups))
		die('plan JSON must be an object with a "groups" array.', EXIT.USAGE);

	const plan = raw as JsonPlan;
	if (plan.groups.length === 0) die("plan has no groups.", EXIT.USAGE);

	const groups: Group[] = plan.groups.map((g, i) => {
		const n = i + 1;
		if (typeof g.subject !== "string" || g.subject.trim() === "")
			die(`group ${n}: missing/invalid "subject".`, EXIT.USAGE);
		if (
			!Array.isArray(g.files) ||
			g.files.length === 0 ||
			!g.files.every((f) => typeof f === "string" && f.trim() !== "")
		)
			die(`group ${n}: missing/invalid "files" array.`, EXIT.USAGE);
		if (g.author !== undefined) validateAuthorFormat(g.author, `group ${n} "author"`);
		for (const c of g.coauthors ?? []) validateAuthorFormat(c, `group ${n} coauthor`);

		let msg = g.subject.trim();
		if (g.body?.trim()) msg += `\n\n${g.body.trim()}`;
		if (g.coauthors?.length) msg += `\n\n${g.coauthors.map((c) => `Co-Authored-By: ${c}`).join("\n")}`;

		return { msg: stripClaudeTrailers(msg), author: g.author, files: g.files };
	});

	return { base: plan.base, groups };
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}
