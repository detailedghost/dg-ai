import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { cwdHash } from "@dg/common/node";
import handler from "../../../../src/pw/commands/state/run";
import spec from "../../../../src/pw/commands/state/spec";
import { UsageError } from "../../../../src/pw/core/args";
import type { DaemonRequest } from "../../../../src/pw/core/socket";
import {
	load,
	save,
	statePathFor,
	statesDir,
} from "../../../../src/pw/core/states";
import {
	argsFor,
	clientEnv,
	startFakeDaemon,
	useTempEnv,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();
const stateRoot = useTempEnv("AI_STATE_DIR");
const cacheRoot = useTempEnv("XDG_CACHE_HOME");

const SECRET = "SECRET-COOKIE-VALUE";
const cookie = {
	name: "sid",
	value: SECRET,
	domain: "a.test",
	path: "/",
	expires: -1,
	httpOnly: true,
	secure: true,
	sameSite: "Lax" as const,
};
const fullState = {
	cookies: [cookie],
	origins: [
		{
			origin: "https://a.test",
			localStorage: [{ name: "k", value: "v" }],
			indexedDB: [{ name: "db" }],
		},
		{ origin: "https://b.test", localStorage: [] },
	],
};

const run = async (...argv: string[]) => {
	const env = clientEnv();
	const code = await handler(argsFor(spec, ...argv), env);
	return { code, env };
};

const argvOf = (request: DaemonRequest): string[] =>
	request.method === "run" ? request.params.argv : [];

describe("state spec", () => {
	test("routes the subcommand and its arguments as positionals", () => {
		expect(argsFor(spec, "save", "site").positionals).toEqual(["save", "site"]);
		expect(argsFor(spec, "import", "/x.json", "site").positionals).toEqual([
			"import",
			"/x.json",
			"site",
		]);
	});
});

describe("state usage", () => {
	test("rejects an unknown subcommand with exit 2", async () => {
		await expect(run("frobnicate")).rejects.toMatchObject({ exitCode: 2 });
	});

	test.each([
		["save"],
		["load"],
		["delete"],
		["import"],
		["list", "x"],
		["save", "a", "b"],
		["import", "f", "n", "x"],
	])("rejects the wrong argument count for %p with exit 2", async (...args) => {
		await expect(run(...(args as string[]))).rejects.toBeInstanceOf(UsageError);
	});

	test.each(["save", "load", "delete"])(
		"%s rejects a traversal name with exit 2 and touches nothing",
		async (sub) => {
			await expect(run(sub, "../x")).rejects.toMatchObject({
				exitCode: 2,
				message: "state name must match ^[a-z0-9][a-z0-9._-]{0,63}$",
			});
			expect(existsSync(path.join(stateRoot.dir, "pw"))).toBe(false);
		},
	);

	test("import rejects an invalid explicit name with exit 2", async () => {
		await expect(run("import", "/x.json", "../x")).rejects.toBeInstanceOf(
			UsageError,
		);
	});
});

describe("state list", () => {
	test("prints the empty hint", async () => {
		const { code, env } = await run("list");
		expect(code).toBe(0);
		expect(env.stdout).toEqual([
			"(no saved states) — run: pw state save <name>",
		]);
	});

	test("prints one line per state", async () => {
		save("site", fullState);
		const { env } = await run("list");
		expect(env.stdout).toHaveLength(1);
		expect(env.stdout[0]).toMatch(
			/^site {2}1 cookies {2}2 origins {2}a\.test {2}\d{4}-\d\d-\d\dT[\d:.]+Z$/,
		);
		expect(env.stdout.join("")).not.toContain(SECRET);
	});
});

describe("legacy import", () => {
	test.each([["list"], ["delete", "zzz"], ["load", "zzz"], ["save", "zzz"]])(
		"runs before %p",
		async (...args) => {
			const legacy = path.join(cacheRoot.dir, "playwright-cli", "sessions");
			mkdirSync(legacy, { recursive: true });
			writeFileSync(
				path.join(legacy, "old.json"),
				'{"cookies":[],"origins":[]}',
			);
			const { env } = await run(...(args as string[]));
			expect(env.stdout[0]).toBe(
				"Imported 1 legacy states from ~/.cache/playwright-cli/sessions/",
			);
			expect(existsSync(statePathFor("old"))).toBe(true);
			expect(existsSync(path.join(legacy, "old.json"))).toBe(true);
		},
	);
});

describe("state delete", () => {
	test("deletes a saved state", async () => {
		save("site", fullState);
		const { code, env } = await run("delete", "site");
		expect(code).toBe(0);
		expect(env.stdout).toEqual(["Deleted state 'site'."]);
		expect(existsSync(statePathFor("site"))).toBe(false);
	});

	test("exits 1 for an unknown name", async () => {
		const { code, env } = await run("delete", "nope");
		expect(code).toBe(1);
		expect(env.stderr).toEqual(["No saved state 'nope'. Run: pw state list"]);
	});
});

describe("state import", () => {
	const incoming = (text: string): string => {
		const file = path.join(stateRoot.dir, "incoming.json");
		writeFileSync(file, text);
		return file;
	};

	test("imports a storage state file under its basename", async () => {
		const { code, env } = await run(
			"import",
			incoming(JSON.stringify(fullState)),
		);
		expect(code).toBe(0);
		expect(env.stdout).toEqual(["Imported state 'incoming'."]);
		expect(statSync(statePathFor("incoming")).mode & 0o777).toBe(0o600);
	});

	test("refuses JSON that is not a storage state, exits 1, and names the file", async () => {
		const file = incoming('{"token":"abc"}');
		const { code, env } = await run("import", file, "site");
		expect(code).toBe(1);
		expect(env.stderr).toEqual([`Not a storage state file: ${file}`]);
		expect(existsSync(statePathFor("site"))).toBe(false);
	});

	test("resolves a relative file against the client directory", async () => {
		const env = clientEnv(stateRoot.dir);
		incoming(JSON.stringify(fullState));
		expect(
			await handler(argsFor(spec, "import", "incoming.json", "rel"), env),
		).toBe(0);
		expect(load("rel").cookies).toHaveLength(1);
	});
});

describe("state save", () => {
	test("exits 1 when the session is not open", async () => {
		const { code, env } = await run("save", "site");
		expect(code).toBe(1);
		expect(env.stderr).toEqual(["Browser 'default' is not open. Run: pw open"]);
	});

	test("has the daemon write a temporary file, stores it as 0600, and removes the temporary file", async () => {
		let temporary = "";
		const daemon = await startFakeDaemon("default", {}, (request) => {
			const [command, file] = argvOf(request);
			expect(command).toBe("state-save");
			temporary = file as string;
			writeFileSync(temporary, JSON.stringify(fullState));
			return { text: "", exitCode: 0 };
		});
		try {
			const { code, env } = await run("save", "site");
			expect(code).toBe(0);
			expect(env.stdout).toEqual([
				"Saved state 'site' (1 cookies, 2 origins).",
			]);
			expect(load("site")).toEqual(fullState);
			expect(statSync(statePathFor("site")).mode & 0o777).toBe(0o600);
			expect(statSync(statesDir()).mode & 0o777).toBe(0o700);
			expect(existsSync(temporary)).toBe(false);
			expect(existsSync(path.dirname(temporary))).toBe(false);
			expect(temporary.startsWith(scratch.dir)).toBe(true);
			expect(env.stdout.join("")).not.toContain(SECRET);
		} finally {
			daemon.dispose();
		}
	});

	test("overwrites an earlier state of the same name", async () => {
		save("site", { cookies: [], origins: [] });
		const daemon = await startFakeDaemon("default", {}, (request) => {
			writeFileSync(argvOf(request)[1] as string, JSON.stringify(fullState));
			return { text: "", exitCode: 0 };
		});
		try {
			expect((await run("save", "site")).code).toBe(0);
			expect(load("site").cookies).toHaveLength(1);
		} finally {
			daemon.dispose();
		}
	});

	test("reports a daemon failure, saves nothing, and cleans up", async () => {
		const daemon = await startFakeDaemon("default", {}, () => ({
			text: "### Error\nboom",
			exitCode: 1,
		}));
		try {
			const { code, env } = await run("save", "site");
			expect(code).toBe(1);
			expect(env.stderr).toEqual(["### Error\nboom"]);
			expect(existsSync(statePathFor("site"))).toBe(false);
			expect(
				readdirSync(path.join(scratch.dir, "pw")).filter((entry) =>
					entry.startsWith("state-"),
				),
			).toEqual([]);
		} finally {
			daemon.dispose();
		}
	});

	test("refuses a daemon file that is not a storage state", async () => {
		const daemon = await startFakeDaemon("default", {}, (request) => {
			writeFileSync(argvOf(request)[1] as string, '{"x":1}');
			return { text: "", exitCode: 0 };
		});
		try {
			const { code } = await run("save", "site");
			expect(code).toBe(1);
			expect(existsSync(statePathFor("site"))).toBe(false);
		} finally {
			daemon.dispose();
		}
	});
});

describe("state load", () => {
	test("exits 1 for an unknown name before it needs a browser", async () => {
		const { code, env } = await run("load", "nope");
		expect(code).toBe(1);
		expect(env.stderr).toEqual(["No saved state 'nope'. Run: pw state list"]);
	});

	test("exits 1 when the session is not open", async () => {
		save("site", fullState);
		const { code, env } = await run("load", "site");
		expect(code).toBe(1);
		expect(env.stderr).toEqual(["Browser 'default' is not open. Run: pw open"]);
	});

	test("asks the daemon to restore the saved file and prints the persistent-session note for IndexedDB", async () => {
		save("site", fullState);
		const seen: string[][] = [];
		const daemon = await startFakeDaemon("default", {}, (request) => {
			seen.push(argvOf(request));
			return { text: "page text with secrets", exitCode: 0 };
		});
		try {
			const { code, env } = await run("load", "site");
			expect(code).toBe(0);
			expect(seen).toEqual([["state-load", statePathFor("site")]]);
			expect(env.stdout).toEqual([
				"Loaded 1 cookies, 1 origins into session 'default'. IndexedDB restores only into --scratch sessions.",
			]);
		} finally {
			daemon.dispose();
		}
	});

	test("omits the IndexedDB note when the file has none", async () => {
		save("site", { cookies: [cookie], origins: [] });
		const daemon = await startFakeDaemon("default");
		try {
			const { env } = await run("load", "site");
			expect(env.stdout).toEqual([
				"Loaded 1 cookies, 0 origins into session 'default'.",
			]);
		} finally {
			daemon.dispose();
		}
	});

	test("points a scratch session to open --from for IndexedDB", async () => {
		save("site", fullState);
		const daemon = await startFakeDaemon(`default@${cwdHash()}`);
		try {
			const { env } = await run("load", "site");
			expect(env.stdout[0]).toBe(
				"Loaded 1 cookies, 1 origins into session 'default'. IndexedDB was not restored. Start with: pw open --scratch --from=site",
			);
		} finally {
			daemon.dispose();
		}
	});

	test("reports a daemon failure without claiming success", async () => {
		save("site", fullState);
		const daemon = await startFakeDaemon("default", {}, () => ({
			text: "### Error\nboom",
			exitCode: 1,
		}));
		try {
			const { code, env } = await run("load", "site");
			expect(code).toBe(1);
			expect(env.stdout).toEqual([]);
			expect(env.stderr).toEqual(["### Error\nboom"]);
		} finally {
			daemon.dispose();
		}
	});

	test("reports a stored file that is not a storage state", async () => {
		mkdirSync(statesDir(), { recursive: true });
		writeFileSync(statePathFor("bad"), '{"x":1}');
		const { code, env } = await run("load", "bad");
		expect(code).toBe(1);
		expect(env.stderr).toEqual([
			`Not a storage state file: ${statePathFor("bad")}`,
		]);
	});
});

describe("secrets", () => {
	test("no subcommand prints cookie values", async () => {
		const daemon = await startFakeDaemon("default", {}, (request) => {
			if (argvOf(request)[0] === "state-save")
				writeFileSync(argvOf(request)[1] as string, JSON.stringify(fullState));
			return { text: "", exitCode: 0 };
		});
		try {
			const outputs = [
				await run("save", "site"),
				await run("load", "site"),
				await run("list"),
				await run("delete", "site"),
			];
			const text = outputs
				.flatMap(({ env }) => [...env.stdout, ...env.stderr])
				.join("\n");
			expect(text).not.toContain(SECRET);
			expect(
				readFileSync(
					path.join(
						import.meta.dir,
						"../../../../src/pw/commands/state/run.ts",
					),
					"utf8",
				),
			).not.toContain("console.");
		} finally {
			daemon.dispose();
		}
	});
});
