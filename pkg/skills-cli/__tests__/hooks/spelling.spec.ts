import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { editInput, hookWorld, SESSION, writeInput } from "./hook-fixtures";

let world: ReturnType<typeof hookWorld>;
beforeEach(() => {
	world = hookWorld();
});
afterEach(() => world.cleanup());

describe("spelling hook", () => {
	test("exits 2 and lists colour -> color for an Edit under en-US", async () => {
		const r = await world.run("spelling", editInput("const colour = 1;"));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("colour -> color");
	});

	test("en-GB passes the same input and flags color", async () => {
		world.setSpellingLocale("en-GB");
		expect(
			(await world.run("spelling", editInput("const colour = 1;"))).code,
		).toBe(0);
		const flagged = await world.run("spelling", editInput("const color = 1;"));
		expect(flagged.code).toBe(2);
		expect(flagged.stderr).toContain("color -> colour");
	});

	test("defaults to en-US when config has no spelling locale", async () => {
		world.setConfig({ hooks: {} });
		expect((await world.run("spelling", editInput("colour"))).code).toBe(2);
	});

	test("passes clean text with no output", async () => {
		const r = await world.run("spelling", editInput("const color = 1;"));
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
	});

	test("splits camelCase identifiers into words", async () => {
		const r = await world.run(
			"spelling",
			editInput("function colourPicker() {}"),
		);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("colour -> color");
	});

	test("scans the content of a Write", async () => {
		const file = world.seed("out/notes.md", "behaviour of the parser\n");
		const r = await world.run(
			"spelling",
			writeInput(file, "behaviour of the parser\n"),
		);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("behaviour -> behavior");
	});

	test("ignores tools other than Edit, Write and MultiEdit", async () => {
		const r = await world.run("spelling", {
			session_id: SESSION,
			tool_name: "Read",
			tool_input: { file_path: "/x" },
		});
		expect(r.code).toBe(0);
	});

	test("caps the findings it lists", async () => {
		const text = Array.from({ length: 20 }, () => "colour").join("\n");
		const r = await world.run("spelling", editInput(text), {
			env: { HOOK_SPELLING_MAX_FINDINGS: "3" },
		});
		expect(r.code).toBe(2);
		expect(r.stderr.match(/colour -> color/g)).toHaveLength(3);
	});

	test("honors the comment-disabled bypass marker for the session", async () => {
		world.disableMarker("comment-disabled");
		const r = await world.run("spelling", editInput("colour"));
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
	});

	test("a bypass marker for another session does not apply", async () => {
		world.disableMarker("comment-disabled", "OTHER");
		expect((await world.run("spelling", editInput("colour"))).code).toBe(2);
	});

	test("scans edits[].new_string of a MultiEdit", async () => {
		const r = await world.run("spelling", {
			session_id: SESSION,
			tool_name: "MultiEdit",
			tool_input: {
				file_path: "/nonexistent/dir/file.ts",
				edits: [
					{ old_string: "a", new_string: "const color = 1;" },
					{ old_string: "b", new_string: "const colour = 2;" },
				],
			},
		});
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("colour -> color");
	});

	test("a MultiEdit edit without new_string does not throw", async () => {
		const r = await world.run("spelling", {
			session_id: SESSION,
			tool_name: "MultiEdit",
			tool_input: {
				file_path: "/nonexistent/dir/file.ts",
				edits: [{ old_string: "a" }, null, { new_string: "const color = 1;" }],
			},
		});
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
	});

	test("a MultiEdit with no edits array passes", async () => {
		const r = await world.run("spelling", {
			session_id: SESSION,
			tool_name: "MultiEdit",
			tool_input: { file_path: "/nonexistent/dir/file.ts" },
		});
		expect(r.code).toBe(0);
	});

	test("an invalid locale value falls back to en-US", async () => {
		world.setSpellingLocale("en-AU");
		const r = await world.run("spelling", editInput("const colour = 1;"));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("colour -> color");
	});

	test("a config.json holding invalid JSON falls back to en-US", async () => {
		writeFileSync(join(world.dgHome, "config.json"), "{nope");
		const r = await world.run("spelling", editInput("const colour = 1;"));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("colour -> color");
	});

	test("CLAUDE_SESSION_ID selects the bypass marker over session_id", async () => {
		world.disableMarker("comment-disabled", "FROM_ENV");
		const viaEnv = await world.run("spelling", editInput("colour"), {
			env: { CLAUDE_SESSION_ID: "FROM_ENV" },
		});
		expect(viaEnv.code).toBe(0);
		const viaInput = await world.run("spelling", editInput("colour"));
		expect(viaInput.code).toBe(2);
	});

	test("a marker for the input session is ignored when CLAUDE_SESSION_ID differs", async () => {
		world.disableMarker("comment-disabled", SESSION);
		const r = await world.run("spelling", editInput("colour"), {
			env: { CLAUDE_SESSION_ID: "FROM_ENV" },
		});
		expect(r.code).toBe(2);
	});

	test("a Write with empty content exits 0", async () => {
		const r = await world.run("spelling", writeInput("/x/empty.md", ""));
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
	});

	test("reports the line number of each finding in multi-line text", async () => {
		const text = ["const a = 1;", "", "const colour = 2;", "// behaviour"].join(
			"\n",
		);
		const r = await world.run("spelling", editInput(text));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("3: colour -> color");
		expect(r.stderr).toContain("4: behaviour -> behavior");
	});

	test("en-GB lets valid British words through", async () => {
		world.setSpellingLocale("en-GB");
		const r = await world.run(
			"spelling",
			editInput('while (x) {} const j = { "license": "MIT" }; best practice'),
		);
		expect(r.code).toBe(0);
	});

	test.each(["while", "license", "story", "program"])(
		"en-GB passes the valid British word %s",
		async (word) => {
			world.setSpellingLocale("en-GB");
			const r = await world.run("spelling", editInput(`the ${word} here`));
			expect(r.code).toBe(0);
		},
	);

	test("en-US passes the valid American word analyses", async () => {
		const r = await world.run("spelling", editInput("two analyses ran"));
		expect(r.code).toBe(0);
	});

	test("en-US lets valid words through", async () => {
		const r = await world.run(
			"spelling",
			editInput("the analyses show grey: gray"),
		);
		expect(r.code).toBe(0);
	});

	test("reads a case variant of the configured locale", async () => {
		world.setSpellingLocale("en-gb");
		const r = await world.run("spelling", editInput("const color = 1;"));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("color -> colour");
	});

	test("reports an invalid locale on stderr and falls back to en-US", async () => {
		world.setSpellingLocale("fr-FR");
		const r = await world.run("spelling", editInput("const colour = 1;"));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain('"fr-FR"');
		expect(r.stderr).toContain("must be one of en-US, en-GB");
	});

	test("reports an unreadable config on stderr and falls back to en-US", async () => {
		writeFileSync(join(world.dgHome, "config.json"), "{nope");
		const r = await world.run("spelling", editInput("const colour = 1;"));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("config.json is unreadable");
	});
});

describe("spelling session id precedence", () => {
	test("CLAUDE_CODE_SESSION_ID wins over CLAUDE_SESSION_ID", async () => {
		world.disableMarker("comment-disabled", "CODE_ENV");
		const r = await world.run("spelling", editInput("colour"), {
			env: { CLAUDE_CODE_SESSION_ID: "CODE_ENV", CLAUDE_SESSION_ID: "OLD_ENV" },
		});
		expect(r.code).toBe(0);
	});
});
