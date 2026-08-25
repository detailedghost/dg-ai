import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
	type DgPaths,
	resolveDgPaths,
	writeSessionToken,
} from "@dg/common/node";
import { cleanupDgHome, freshDgHome } from "@dg/dg-daemon/test-harness";
import { runCli } from "../cli-wire";

const UNUSED_PORT = 0;
const EMPTY_STDIN = new Uint8Array(0);

let dgHome: string;
let paths: DgPaths;

function registerSessionFile(sessionId: string, agentIdentity: string): void {
	writeSessionToken(paths, sessionId, {
		sessionId,
		token: `token-${sessionId}`,
		cwd: process.cwd(),
		agentIdentity,
	});
}

function memory(
	args: string[],
	opts: { stdin?: Uint8Array } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return runCli(dgHome, UNUSED_PORT, ["memory", ...args], {}, opts);
}

async function writeMemory(args: string[]): Promise<string> {
	const result = await memory(["write", ...args]);
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(0);
	return result.stdout.trim();
}

beforeEach(() => {
	dgHome = freshDgHome();
	paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	registerSessionFile("sess-alpha", "alpha");
});

afterEach(() => {
	cleanupDgHome(dgHome);
});

describe("dg-agent memory, with no daemon anywhere", () => {
	it("writes a memory and reads it back without ever starting one", async () => {
		const id = await writeMemory([
			"port bind race",
			"the harness raced itself",
		]);
		const read = await memory(["read", id]);

		expect(read.stdout).toBe("port bind race\n\nthe harness raced itself\n");
		expect(read.exitCode).toBe(0);
		expect(existsSync(paths.pidPath)).toBe(false);
	});
});

describe("memory write", () => {
	it("reads the body from stdin when no body argument is given", async () => {
		const written = await memory(["write", "idle window"], {
			stdin: new TextEncoder().encode("the daemon stops after a day\n"),
		});
		const id = written.stdout.trim();
		const read = await memory(["read", id]);

		expect(written.exitCode).toBe(0);
		expect(read.stdout).toBe("idle window\n\nthe daemon stops after a day\n");
	});

	it("refuses an empty stdin rather than recording a blank memory", async () => {
		const written = await memory(["write", "idle window"], {
			stdin: EMPTY_STDIN,
		});

		expect(written.exitCode).toBe(1);
		expect(written.stderr).toContain("the piped body was empty");
	});

	it("replaces what the agent knew under that title", async () => {
		const first = await writeMemory(["deploy steps", "old steps"]);
		const second = await writeMemory(["deploy steps", "new steps"]);
		const listed = await memory(["search"]);

		expect(second).toBe(first);
		expect(listed.stdout.trim().split("\n")).toHaveLength(1);
		expect((await memory(["read", first])).stdout).toContain("new steps");
	});

	it("records under the identity of the sole session in this directory", async () => {
		const id = await writeMemory(["one", "body"]);
		const full = await memory(["read", id, "--full"]);

		expect(JSON.parse(full.stdout).agentIdentity).toBe("alpha");
	});

	it("records under an explicit identity instead", async () => {
		const id = await writeMemory(["one", "body", "--identity", "beta"]);
		const full = await memory(["read", id, "--full"]);

		expect(JSON.parse(full.stdout).agentIdentity).toBe("beta");
	});

	it("records under the identity of the session the caller named", async () => {
		registerSessionFile("sess-beta", "beta");
		const written = await runCli(dgHome, UNUSED_PORT, [
			"-s",
			"sess-beta",
			"memory",
			"write",
			"one",
			"body",
		]);
		const full = await memory(["read", written.stdout.trim(), "--full"]);

		expect(JSON.parse(full.stdout).agentIdentity).toBe("beta");
	});

	it("says which sessions exist when the directory resolves to none", async () => {
		const written = await runCli(
			dgHome,
			UNUSED_PORT,
			["memory", "write", "one", "body"],
			{},
			{ cwd: "/" },
		);

		expect(written.exitCode).toBe(1);
		expect(written.stderr).toContain("cannot resolve a session for cwd");
		expect(written.stderr).toContain("sess-alpha");
	});

	it("records a workset scope on the memory", async () => {
		const id = await writeMemory(["one", "body", "--workset", "dg"]);
		const full = await memory(["read", id, "--full"]);

		expect(JSON.parse(full.stdout).workset).toBe("dg");
	});

	it("records a kind on the memory", async () => {
		const id = await writeMemory(["one", "body", "--kind", "decision"]);
		const full = await memory(["read", id, "--full"]);

		expect(JSON.parse(full.stdout).kind).toBe("decision");
	});
});

describe("memory search", () => {
	beforeEach(async () => {
		await writeMemory(["port bind race", "the harness raced itself"]);
		await writeMemory([
			"asset crypto",
			"base64 tax on every asset",
			"--workset",
			"dg",
		]);
		await writeMemory([
			"idle window",
			"the daemon stops",
			"--identity",
			"beta",
		]);
	});

	it("prints one line per hit, id first, so a caller can pipe it", async () => {
		const found = await memory(["search", "port"]);
		const lines = found.stdout.trim().split("\n");

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/^[0-9a-f-]{36} {2}\d{4}-\d{2}-\d{2} {2}port bind race$/,
		);
	});

	it("marks the workset a memory belongs to", async () => {
		const found = await memory(["search", "base64"]);

		expect(found.stdout.trim()).toContain("[dg]  asset crypto");
	});

	it("prints the whole record as JSON when asked for everything", async () => {
		const found = await memory(["search", "port", "--full"]);
		const record = JSON.parse(found.stdout.trim());

		expect(record.title).toBe("port bind race");
		expect(record.body).toBe("the harness raced itself");
	});

	it("searches only this agent's memories", async () => {
		expect((await memory(["search", "daemon"])).stdout).toBe("");
		expect(
			(await memory(["search", "daemon", "--identity", "beta"])).stdout,
		).toContain("idle window");
	});

	it("lists the most recent first when given no query", async () => {
		const listed = await memory(["search"]);

		expect(
			listed.stdout
				.trim()
				.split("\n")
				.map((line) => line.split("  ")[2]),
		).toEqual(["asset crypto", "port bind race"]);
	});

	it("restricts the listing to one workset", async () => {
		const listed = await memory(["search", "--workset", "dg"]);

		expect(listed.stdout.trim().split("\n")).toHaveLength(1);
		expect(listed.stdout).toContain("asset crypto");
	});

	it("pages through the hits", async () => {
		const first = await memory(["search", "--limit", "1"]);
		const second = await memory(["search", "--limit", "1", "--offset", "1"]);

		expect(first.stdout).toContain("asset crypto");
		expect(second.stdout).toContain("port bind race");
	});

	it("refuses a limit that is not a count", async () => {
		const bad = await memory(["search", "--limit", "many"]);

		expect(bad.exitCode).toBe(1);
		expect(bad.stderr).toContain("--limit must be a non-negative integer");
	});

	it("prints nothing and succeeds when nothing matches", async () => {
		const found = await memory(["search", "nonexistentterm"]);

		expect(found.stdout).toBe("");
		expect(found.exitCode).toBe(0);
	});
});

describe("memory read and forget", () => {
	it("fails loudly on an id that is not there", async () => {
		const read = await memory(["read", "no-such-id"]);
		const forget = await memory(["forget", "no-such-id"]);

		expect(read.exitCode).toBe(1);
		expect(read.stderr).toContain("no memory with id no-such-id");
		expect(forget.exitCode).toBe(1);
		expect(forget.stderr).toContain("no memory with id no-such-id");
	});

	it("forgets a memory once, and only once", async () => {
		const id = await writeMemory(["one", "body"]);
		const first = await memory(["forget", id]);
		const second = await memory(["forget", id]);

		expect(first.exitCode).toBe(0);
		expect(first.stdout).toBe("");
		expect(second.exitCode).toBe(1);
		expect((await memory(["search", "body"])).stdout).toBe("");
	});
});

describe("the help text", () => {
	it("offers memory beside the session commands", async () => {
		const help = await runCli(dgHome, UNUSED_PORT, ["--help"]);

		expect(help.stdout).toContain("memory");
		expect(help.stdout).toContain("recv");
	});

	it("lists all four memory verbs", async () => {
		const help = await memory(["--help"]);

		for (const verb of ["write", "search", "read", "forget"]) {
			expect(help.stdout).toContain(verb);
		}
	});
});
