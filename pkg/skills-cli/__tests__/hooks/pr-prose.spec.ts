import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bashInput, hookWorld } from "./hook-fixtures";

let world: ReturnType<typeof hookWorld>;
beforeEach(() => {
	world = hookWorld();
});
afterEach(() => world.cleanup());

const GOOD_BODY = [
	"## Summary",
	"",
	"The upload endpoint dropped files larger than 8 MB because the multipart parser",
	"buffered the whole request in memory and hit the Lambda limit. This streams the",
	"body to S3 instead, so size no longer depends on available memory.",
	"",
	"## Changes",
	"",
	"- Stream multipart uploads straight to S3",
	"- Drop the in-memory buffer in `parseUpload`",
	"",
	"## Testing",
	"",
	"`bun test upload` passes, including a new 200 MB fixture.",
].join("\n");

const quote = (body: string) =>
	body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const create = (body: string) => `gh pr create --body "${quote(body)}"`;
const heredoc = (flag: string, body: string, tag = "EOF") =>
	[
		`gh pr create --title "fix: stream uploads" ${flag} "$(cat <<'${tag}'`,
		body,
		tag,
		`)"`,
	].join("\n");

async function judge(
	command: string,
	env: Record<string, string | undefined> = {},
) {
	return world.run("pr-prose", bashInput(command), { env });
}

describe("pr-prose body extraction", () => {
	test("judges the body of a heredoc passed to --body", async () => {
		const r = await judge(
			heredoc("--body", "<!-- describe -->\nRefactored things.\nTBD"),
		);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("placeholder marker");
	});

	test("passes a clean heredoc body", async () => {
		const r = await judge(heredoc("--body", GOOD_BODY));
		expect(r.code).toBe(0);
	});

	test("attributes the heredoc to --body and not to a heredoc --title", async () => {
		const command = [
			`gh pr create --title "$(cat <<'T'`,
			"TBD",
			"T",
			`)" --body "$(cat <<'B'`,
			"Streams uploads to S3 instead of buffering them.",
			"B",
			`)"`,
		].join("\n");
		expect((await judge(command)).code).toBe(0);
	});

	test("ignores a body flag on a command before the PR command", async () => {
		const r = await judge(`other-tool --body TODO; ${create(GOOD_BODY)}`);
		expect(r.code).toBe(0);
	});

	test("keeps a backslash that the shell keeps inside double quotes", async () => {
		const { shellWords: tokenize } = await import("../../src/hooks/pr-command");
		expect(
			tokenize(String.raw`--body "C:\temp\new \"x\" \$HOME \\ end"`),
		).toEqual(["--body", String.raw`C:\temp\new "x" $HOME \ end`]);
	});

	test("reads --body-file", async () => {
		const file = world.seed(
			"body.md",
			"<!-- describe -->\nRefactored things.\nTBD\n",
		);
		expect((await judge(`gh pr create --body-file ${file}`)).code).toBe(2);
		expect((await judge(`gh pr create --body-file=${file}`)).code).toBe(2);
	});

	test("passes a clean --body-file", async () => {
		const file = world.seed("body.md", `${GOOD_BODY}\n`);
		expect((await judge(`gh pr create --body-file ${file}`)).code).toBe(0);
	});

	test("passes when the --body-file is missing", async () => {
		expect(
			(await judge("gh pr create --body-file /nonexistent/nope.md")).code,
		).toBe(0);
	});

	test("reads -b and --body=VALUE", async () => {
		expect((await judge("gh pr create -b 'TBD later'")).code).toBe(2);
		expect((await judge("gh pr create --body=TBD")).code).toBe(2);
	});

	test("reads a body after an escaped newline", async () => {
		expect(
			(await judge("gh pr create --title x --body \\\n    'TBD'")).code,
		).toBe(2);
		expect(
			(
				await judge(
					'gh pr create --title "x" \\\n--body "We fixed the parser bug here.\nTBD"',
				)
			).code,
		).toBe(2);
	});

	test("ignores a flag line that the shell runs as its own command", async () => {
		expect((await judge('gh pr create --title "x"\n--body "TBD"')).code).toBe(
			0,
		);
	});

	test("reads the body only from the matched PR invocation", async () => {
		expect((await judge(`sh -c "gh pr create --body 'TBD'"`)).code).toBe(2);
		expect(
			(await judge("gh pr edit 42 --add-label bug && echo --body TODO")).code,
		).toBe(0);
	});

	test("skips PR text inside a quoted argument", async () => {
		expect(
			(
				await judge(
					"git commit -m 'docs: examples; gh pr create --title x --body TBD'",
				)
			).code,
		).toBe(0);
	});

	test("reads a backslash-continued command", async () => {
		expect(
			(
				await judge(
					'gh pr create \\\n  --body "We fixed the parser bug here.\nTBD"',
				)
			).code,
		).toBe(2);
	});

	test("reads glab --description, -d and --description-file", async () => {
		const file = world.seed("desc.md", "<!-- describe -->\nTBD\n");
		expect(
			(
				await judge(
					'glab mr create --description "<!-- describe -->\nRefactored things.\nTBD"',
				)
			).code,
		).toBe(2);
		expect((await judge("glab mr create -d 'TBD later'")).code).toBe(2);
		expect(
			(await judge(`glab mr create --description-file ${file}`)).code,
		).toBe(2);
		expect(
			(
				await judge(
					heredoc("--description", "TBD", "D").replace("gh pr", "glab mr"),
				)
			).code,
		).toBe(2);
	});

	test("passes a clean glab description", async () => {
		const r = await judge(`glab mr create --description "${quote(GOOD_BODY)}"`);
		expect(r.code).toBe(0);
	});

	test("passes when the body comes from commits or an editor", async () => {
		expect((await judge("gh pr create --fill")).code).toBe(0);
		expect((await judge("gh pr edit 42 --add-label bug")).code).toBe(0);
	});

	test("reads the Codex tool_input.cmd field", async () => {
		const r = await world.run(
			"pr-prose",
			bashInput('gh pr create --body "<!-- describe -->\nTBD"', "cmd"),
		);
		expect(r.code).toBe(2);
	});
});

describe("pr-prose heuristics", () => {
	test("passes a clean body with no findings", async () => {
		const r = await judge(create(GOOD_BODY));
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("body line");
	});

	test("blocks a body that does not read as plain English", async () => {
		const r = await judge(create("<!-- describe -->\nRefactored things.\nTBD"));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("does not read as plain English");
		expect(r.stderr).toContain("fix: rewrite the body as plain English");
	});

	test("reports findings with body line numbers", async () => {
		const r = await judge(create("We fixed the parser bug here.\nTBD"));
		expect(r.stderr).toMatch(/body line 2:/);
	});

	test("flags an unexpanded template comment but allows chain markers", async () => {
		const bad = await judge(
			create("<!-- Describe your changes -->\nSome real text goes here now."),
		);
		expect(bad.stderr).toContain("unexpanded template comment");
		const ok = await judge(
			create(
				"We fixed the parser bug.\n<!-- /chain:start -->\n<!-- /chain:end -->",
			),
		);
		expect(ok.stderr).not.toContain("unexpanded template comment");
	});

	test("flags leftover placeholders and an issue reference with no number", async () => {
		expect(
			(await judge(create("We fixed the parser bug.\nTBD"))).stderr,
		).toContain("placeholder marker");
		expect(
			(await judge(create("We fixed the parser bug.\nTODO: write this up")))
				.stderr,
		).toContain("placeholder marker");
		expect(
			(await judge(create("This fixes the upload path.\nFixes #"))).stderr,
		).toContain("no issue number");
	});

	test("flags a 40-word sentence", async () => {
		const long = `This change ${"word ".repeat(45)}ends here.`;
		const r = await judge(create(long));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("split it into shorter ones");
	});

	test("honors the sentence length tunable", async () => {
		const body = `This change ${"word ".repeat(15)}ends here.`;
		expect((await judge(create(body))).code).toBe(0);
		expect(
			(await judge(create(body), { HOOK_PR_PROSE_MAX_SENTENCE: "10" })).code,
		).toBe(2);
	});

	test("flags marketing filler", async () => {
		const r = await judge(
			create("This adds a comprehensive fix for the upload path."),
		);
		expect(r.stderr).toContain("marketing filler: 'comprehensive'");
	});

	test("flags a bullets-only body with no summary", async () => {
		const body = [
			"## Changes",
			"- Refactored the upload path so it streams",
			"- Added a cap on request size to protect the bucket",
			"- Removed the old buffering helper that is now unused",
		].join("\n");
		expect((await judge(create(body))).stderr).toContain("no prose summary");
	});

	test("flags bullets that come before any prose", async () => {
		const body = [
			"## Changes",
			"- Streams the upload path to S3 now",
			"- Caps request size so the bucket cannot fill",
			"",
			"This removes the in-memory buffer that caused the failures.",
		].join("\n");
		const r = await judge(create(body));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("bullets start before any prose");
	});

	test("exempts a terse body from the summary rule", async () => {
		const r = await judge(create("Bumps deps."));
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("no prose summary");
	});

	test("ignores fenced code, tables, quotes and the generated footer", async () => {
		const body = [
			"This streams uploads to S3 rather than buffering them in memory.",
			"",
			"```js",
			"// TODO: a comprehensive seamless refactor",
			"```",
			"",
			"| col | col |",
			"| --- | --- |",
			"",
			"> quoted text that is comprehensive",
			"",
			"Generated with [Claude Code](https://claude.com/claude-code)",
			"Co-Authored-By: Someone <x@y.z>",
		].join("\n");
		expect((await judge(create(body))).code).toBe(0);
	});

	test("treats a tilde fence like a backtick fence", async () => {
		const body = [
			"This streams uploads to S3 rather than buffering.",
			"~~~",
			"TBD",
			"~~~",
		].join("\n");
		expect((await judge(create(body))).code).toBe(0);
	});

	test("flags a body that is only a code dump", async () => {
		const body = [
			"```js",
			"const x = 1;",
			"const y = 2;",
			"const z = 3;",
			"```",
		].join("\n");
		expect((await judge(create(body))).stderr).toContain("no prose summary");
	});

	test("judges a CRLF body the same as an LF one", async () => {
		const body =
			"## Changes\r\n\r\n- one item here\r\n- two items here\r\n- three items now\r\n";
		expect((await judge(create(body))).stderr).toContain("no prose summary");
	});

	test("does not block on spelling", async () => {
		expect((await judge(create("Bumps deps."))).code).toBe(0);
		expect(
			(await judge(create("Rewires the kubelet sidecar shim."))).code,
		).toBe(0);
	});

	test("caps the number of findings reported", async () => {
		const body = Array.from({ length: 30 }, (_, i) => `TBD item ${i}`).join(
			"\n",
		);
		const r = await judge(create(body), { HOOK_PR_PROSE_MAX_FINDINGS: "5" });
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("more, raise HOOK_PR_PROSE_MAX_FINDINGS");
		expect(r.stderr.split("body line ").length - 1).toBe(5);
	});
});

describe("pr-prose command guard and bypass", () => {
	test("ignores commands that are not PR or MR create or edit", async () => {
		for (const command of [
			"ls -la",
			"git commit -m 'comprehensive TBD'",
			"glab mr view 42",
			"glab mr merge 42",
		]) {
			const r = await judge(command);
			expect(r.code).toBe(0);
			expect(r.stderr).toBe("");
		}
	});

	test("checks gh pr edit and glab mr update bodies", async () => {
		expect(
			(await judge('gh pr edit 42 --body "<!-- describe -->\nTBD"')).code,
		).toBe(2);
		expect(
			(await judge('glab mr update 42 --description "<!-- describe -->\nTBD"'))
				.code,
		).toBe(2);
	});

	test("honors the pr-prose-disabled bypass marker for the session", async () => {
		world.disableMarker("pr-prose-disabled");
		expect(
			(await judge('gh pr create --body "<!-- describe -->\nTBD"')).code,
		).toBe(0);
		expect(
			(await judge('glab mr create --description "<!-- describe -->\nTBD"'))
				.code,
		).toBe(0);
	});
});

describe("pr-prose optional Vale", () => {
	test("prints an install hint and still runs the heuristics when vale is absent", async () => {
		const r = await world.run(
			"pr-prose",
			bashInput(create("<!-- describe -->\nRefactored stuff.\nTBD")),
			{
				which: () => undefined,
			},
		);
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/vale/i);
		expect(r.stderr).toContain("placeholder marker");
	});

	test("a clean body still passes when vale is absent", async () => {
		const r = await world.run("pr-prose", bashInput(create(GOOD_BODY)), {
			which: () => undefined,
		});
		expect(r.code).toBe(0);
	});
});

describe("pr-prose with Vale present", () => {
	const VALE_CONFIG = "/cfg/.vale.ini";
	const present = (bin: string) => (bin === "vale" ? "/fake/vale" : undefined);

	test("prints no install hint when vale is on PATH", async () => {
		const r = await world.run("pr-prose", bashInput(create(GOOD_BODY)), {
			which: present,
		});
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("Install it");
	});

	test("prints a notice when vale is on PATH but unconfigured", async () => {
		const r = await world.run("pr-prose", bashInput(create(GOOD_BODY)), {
			which: present,
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("HOOK_PR_PROSE_VALE_CONFIG is not set");
	});

	test("shows the install hint once per session when vale is absent", async () => {
		const input = bashInput(create(GOOD_BODY));
		const first = await world.run("pr-prose", input, {
			which: () => undefined,
		});
		const second = await world.run("pr-prose", input, {
			which: () => undefined,
		});
		expect(first.stdout).toMatch(/vale\.sh/);
		expect(second.stdout).toBe("");
	});

	test("judges a body passed as a <<< here-string", async () => {
		const r = await judge(
			`gh pr create --title "fix: x" --body "$(cat <<< 'Refactored things. TBD')"`,
		);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("placeholder marker");
	});

	test("a here-string is not read as a heredoc", async () => {
		const command = `cat <<<"x" && gh pr create --body "${GOOD_BODY.replace(/"/g, "'")}"`;
		const r = await world.run("pr-prose", bashInput(command));
		expect(r.code).toBe(0);
	});

	test("makes no vale call without a configured vale config", async () => {
		await world.run("pr-prose", bashInput(create(GOOD_BODY)), {
			which: present,
		});
		expect(world.calls).toEqual([]);
	});

	test("runs vale on the body and parses its rows into findings", async () => {
		const r = await world.run("pr-prose", bashInput(create(GOOD_BODY)), {
			which: present,
			env: { HOOK_PR_PROSE_VALE_CONFIG: VALE_CONFIG },
			reply: {
				status: 1,
				stdout:
					"body.md:4:9:Google.Passive:'was dropped' is passive voice.\nnot a row\n",
			},
		});
		expect(r.code).toBe(2);
		expect(r.stderr).toContain(
			"body line 4: 'was dropped' is passive voice. (Google.Passive)",
		);
		expect(world.calls).toHaveLength(1);
		const argv = world.calls[0]?.argv ?? [];
		expect(argv[0]).toBe("vale");
		expect(argv).toContain(`--config=${VALE_CONFIG}`);
		expect(argv.at(-1)).toBe("body.md");
	});

	test("passes the configured alert level to vale", async () => {
		await world.run("pr-prose", bashInput(create(GOOD_BODY)), {
			which: present,
			env: {
				HOOK_PR_PROSE_VALE_CONFIG: VALE_CONFIG,
				HOOK_PR_PROSE_LEVEL: "error",
			},
		});
		expect(world.calls[0]?.argv).toContain("--minAlertLevel=error");
	});

	test("tolerates a failing vale run and still runs the heuristics", async () => {
		const failing = {
			which: present,
			env: { HOOK_PR_PROSE_VALE_CONFIG: VALE_CONFIG },
			reply: { status: 127, stderr: "vale: command failed" },
		};
		const clean = await world.run(
			"pr-prose",
			bashInput(create(GOOD_BODY)),
			failing,
		);
		expect(clean.code).toBe(0);
		const bad = await world.run(
			"pr-prose",
			bashInput(create("<!-- describe -->\nRefactored stuff.\nTBD")),
			failing,
		);
		expect(bad.code).toBe(2);
		expect(bad.stderr).toContain("placeholder marker");
	});

	test("merges vale findings with heuristics sorted by line", async () => {
		const r = await world.run(
			"pr-prose",
			bashInput(create("Streams uploads now.\nTBD")),
			{
				which: present,
				env: { HOOK_PR_PROSE_VALE_CONFIG: VALE_CONFIG },
				reply: { status: 1, stdout: "body.md:1:1:Google.Will:Avoid 'will'." },
			},
		);
		const vale = r.stderr.indexOf("body line 1:");
		const heuristic = r.stderr.indexOf("body line 2:");
		expect(vale).toBeGreaterThanOrEqual(0);
		expect(heuristic).toBeGreaterThanOrEqual(0);
		expect(vale).toBeLessThan(heuristic);
	});
});

describe("pr-prose with several PR calls", () => {
	test("checks every PR invocation in one command", async () => {
		expect(
			(await judge("gh pr edit 42 --add-label bug && gh pr create --body TBD"))
				.code,
		).toBe(2);
	});
});

describe("pr-prose shell edge cases", () => {
	test("reads quoted heredoc-like text as body text", async () => {
		expect((await judge("gh pr create --body 'TBD <<EOF'")).code).toBe(2);
	});

	test("resolves a relative --body-file against a prior cd", async () => {
		world.seed("subdir/body.md", "TBD\n");
		const r = await world.run("pr-prose", {
			...bashInput("cd subdir && gh pr create --body-file body.md"),
			cwd: world.work,
		});
		expect(r.code).toBe(2);
	});

	test("checks a create that follows a heredoc on the next line", async () => {
		expect(
			(
				await judge(
					"gh pr edit 1 --body-file - <<'EOF'\nWe fixed the parser.\nEOF\ngh pr create --body TBD",
				)
			).code,
		).toBe(2);
	});
});

describe("pr-prose directory scope", () => {
	test("keeps a cd inside a subshell out of the next command", async () => {
		world.seed("body.md", "TBD\n");
		world.seed("subdir/body.md", "We fixed the parser bug.\n");
		const r = await world.run("pr-prose", {
			...bashInput("(cd subdir && :); gh pr create --body-file body.md"),
			cwd: world.work,
		});
		expect(r.code).toBe(2);
	});

	test("resolves a PR call in a substitution from its command's start directory", async () => {
		world.seed("body.md", "TBD\n");
		world.seed("subdir/body.md", "We fixed the parser bug.\n");
		const r = await world.run("pr-prose", {
			...bashInput('cd "$(gh pr create --body-file body.md)" && cd subdir'),
			cwd: world.work,
		});
		expect(r.code).toBe(2);
	});
});
