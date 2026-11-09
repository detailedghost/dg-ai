import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	PW_EXT_READ_VERBS,
	PW_EXT_WRITE_VERBS,
	type PwExtCliRequest,
} from "@dg/common";
import { main } from "../../src/pw/cli";
import { type ExtClient, type ExtDeps, runExt } from "../../src/pw/ext";
import { clientEnv, useTempScratch } from "../../src/pw/test-support";

const scratch = useTempScratch();

function deps(
	reply: (frame: PwExtCliRequest) => Record<string, unknown>,
	overrides: Partial<ExtDeps> = {},
) {
	const sent: PwExtCliRequest[] = [];
	const cancels: unknown[] = [];
	const posted: { name: string; bytes: string }[] = [];
	let closed = false;
	let interrupt: (() => void) | undefined;
	const client: ExtClient = {
		send(frame) {
			cancels.push(frame);
		},
		async postAsset(name, bytes) {
			posted.push({ name, bytes: bytes.toString() });
			return "123e4567-e89b-42d3-a456-426614174000";
		},
		async request(frame, accept) {
			sent.push(frame as PwExtCliRequest);
			const answer = {
				type: "cli-pw-ext-result",
				sessionId: "s1",
				requestId: (frame as PwExtCliRequest).requestId,
				...reply(frame as PwExtCliRequest),
			};
			if (!accept(answer)) throw new Error("reply not accepted");
			return answer;
		},
		close() {
			closed = true;
		},
	};
	const value: ExtDeps = {
		connect: async () => client,
		cliOnly: () => false,
		onInterrupt: (handler) => {
			interrupt = handler;
			return () => {
				interrupt = undefined;
			};
		},
		...overrides,
	};
	return {
		value,
		sent,
		cancels,
		posted,
		closed: () => closed,
		interrupt: () => interrupt?.(),
	};
}

describe("pw --ext", () => {
	test("sends one verb and prints the redacted text", async () => {
		const env = clientEnv();
		const d = deps(() => ({
			ok: true,
			data: { text: "### Page\n- Page URL: https://x.test/?token=zzzzzzzzzzzz" },
		}));
		expect(await runExt(["--ext", "snapshot"], env, d.value)).toBe(0);
		expect(d.sent).toEqual([
			{
				type: "cli-pw-ext-request",
				requestId: expect.any(String),
				request: { verb: "snapshot" },
			},
		]);
		expect(env.stdout.join("\n")).toContain("### Page");
		expect(env.stdout.join("\n")).not.toContain("zzzzzzzzzzzz");
		expect(d.closed()).toBe(true);
	});

	test.each([
		[["open", "https://example.test/"], { verb: "open", url: "https://example.test/" }],
		[["click", "e3"], { verb: "click", target: "e3" }],
		[["fill", "#q", "cats"], { verb: "fill", target: "#q", value: "cats" }],
		[["count", "input[type=file]"], { verb: "count", target: "input[type=file]" }],
		[["current"], { verb: "current" }],
		[["selection"], { verb: "selection" }],
		[["console"], { verb: "console" }],
	])("maps %p to %p", async (argv, request) => {
		const d = deps(() => ({ ok: true, data: { text: "ok" } }));
		expect(await runExt(["--ext", ...argv], clientEnv(), d.value)).toBe(0);
		expect(d.sent[0]?.request).toEqual(request as never);
	});

	test.each([
		[["--session", "abc", "current"]],
		[["--session=abc", "current"]],
	])("passes --session to the session lookup: %p", async (argv) => {
		const asked: (string | undefined)[] = [];
		const d = deps(() => ({ ok: true, data: { text: "ok" } }));
		const connect = d.value.connect;
		d.value.connect = (sessionId) => {
			asked.push(sessionId);
			return connect(sessionId);
		};
		expect(await runExt(["--ext", ...argv], clientEnv(), d.value)).toBe(0);
		expect(asked).toEqual(["abc"]);
	});

	test("leaves the session choice to the lookup without --session", async () => {
		const asked: (string | undefined)[] = [];
		const d = deps(() => ({ ok: true, data: { text: "ok" } }));
		const connect = d.value.connect;
		d.value.connect = (sessionId) => {
			asked.push(sessionId);
			return connect(sessionId);
		};
		await runExt(["--ext", "current"], clientEnv(), d.value);
		expect(asked).toEqual([undefined]);
	});

	test("documents --session, DG_SESSION_ID and count in the help", async () => {
		const env = clientEnv();
		expect(await runExt(["--ext", "--help"], env, deps(() => ({})).value)).toBe(0);
		const help = env.stdout.join("\n");
		expect(help).toContain("--session <id>");
		expect(help).toContain("DG_SESSION_ID");
		expect(help).toContain("count <ref|selector>");
	});

	test("saves a screenshot to the pw scratch dir and prints the path", async () => {
		const env = clientEnv();
		const d = deps(() => ({
			ok: true,
			data: { text: "### Page", image: "data:image/jpeg;base64,/9j/4AAQ" },
		}));
		expect(await runExt(["--ext", "screenshot"], env, d.value)).toBe(0);
		const out = env.stdout.join("\n");
		const file = out.match(/\[Screenshot of visible tab\]\(([^)]+)\)/)?.[1];
		expect(file).toBeDefined();
		expect(file!.startsWith(scratch.dir)).toBe(true);
		expect(file!.endsWith(".jpg")).toBe(true);
		expect(readFileSync(file!)).toEqual(Buffer.from("/9j/4AAQ", "base64"));
		expect(statSync(file!).mode & 0o777).toBe(0o600);
	});

	test.each([
		[["nope"]],
		[["eval", "1+1"]],
		[["run-code", "x"]],
		[["open"]],
		[["open", "chrome://settings"]],
		[["open", "javascript:alert(1)"]],
		[["click"]],
		[["fill", "#q"]],
		[["current", "extra"]],
		[["-s=web", "current"]],
		[["current", "--approved"]],
	])("refuses %p with exit 2 and sends nothing", async (argv) => {
		const env = clientEnv();
		const d = deps(() => ({ ok: true, data: { text: "x" } }));
		expect(await runExt(["--ext", ...argv], env, d.value)).toBe(2);
		expect(d.sent).toEqual([]);
		expect(env.stderr.join("\n")).not.toBe("");
	});

	test("prints a denial as an error", async () => {
		const env = clientEnv();
		const d = deps(() => ({
			ok: false,
			error: "The request was denied in the browser.",
		}));
		expect(await runExt(["--ext", "click", "e1"], env, d.value)).toBe(1);
		expect(env.stderr).toEqual(["The request was denied in the browser."]);
	});

	test("refuses on a CLI-only install", async () => {
		const env = clientEnv();
		const d = deps(() => ({ ok: true, data: { text: "x" } }), {
			cliOnly: () => true,
		});
		expect(await runExt(["--ext", "current"], env, d.value)).toBe(1);
		expect(env.stderr.join("\n")).toContain("CLI-only install");
		expect(d.sent).toEqual([]);
	});

	test("explains how to pair when no session is reachable", async () => {
		const env = clientEnv();
		const d = deps(() => ({}), {
			connect: async () => {
				throw new Error("no dg session");
			},
		});
		expect(await runExt(["--ext", "current"], env, d.value)).toBe(1);
		expect(env.stderr.join("\n")).toContain("dg-skills doctor pw");
	});

	test("rejects an invalid reply from the daemon", async () => {
		const env = clientEnv();
		const d = deps(() => ({ ok: true, data: { text: "x", cookies: "a" } }));
		expect(await runExt(["--ext", "current"], env, d.value)).toBe(1);
		expect(env.stderr.join("\n")).toContain("Invalid reply");
	});

	test("prints help for --ext", async () => {
		const env = clientEnv();
		expect(await runExt(["--ext", "--help"], env, deps(() => ({})).value)).toBe(0);
		expect(env.stdout.join("\n")).toContain("snapshot");
		expect(env.stdout.join("\n")).toContain("no approval per call");
		expect(env.stdout.join("\n")).not.toContain("approve every call");
	});
});

describe("pw --ext tab verbs and --tab", () => {
	const TAB_USAGE = "pw --ext --tab takes a tab id from pw --ext tabs.";

	test.each([
		[["--tab", "12", "snapshot"], { verb: "snapshot", tabId: 12 }],
		[["snapshot", "--tab", "12"], { verb: "snapshot", tabId: 12 }],
		[["--tab", "0", "snapshot"], { verb: "snapshot", tabId: 0 }],
		[["--tab", "12", "click", "e4"], { verb: "click", target: "e4", tabId: 12 }],
		[["--tab", "12", "screenshot"], { verb: "screenshot", tabId: 12 }],
		[["tabs"], { verb: "tabs" }],
		[["new"], { verb: "new" }],
		[["new", "https://a.example"], { verb: "new", url: "https://a.example" }],
		[["select", "12"], { verb: "select", tabId: 12 }],
		[["close"], { verb: "close" }],
		[["close", "12"], { verb: "close", tabId: 12 }],
		[["--tab", "12", "close"], { verb: "close", tabId: 12 }],
	])("maps %p to %p", async (argv, request) => {
		const d = deps(() => ({ ok: true, data: { text: "ok" } }));

		expect(await runExt(["--ext", ...argv], clientEnv(), d.value)).toBe(0);
		expect(d.sent[0]?.request).toEqual(request as never);
	});

	test("points to the --tab=<value> form for a negative --tab in the space form", async () => {
		const env = clientEnv();
		const d = deps(() => ({ ok: true, data: { text: "x" } }));

		expect(await runExt(["--ext", "--tab", "-1", "snapshot"], env, d.value)).toBe(2);
		expect(env.stderr.join("\n")).toContain("--tab=-XYZ");
		expect(d.sent).toEqual([]);
	});

	test("prints the tab usage text for a --tab value that is not an id", async () => {
		for (const value of ["x", "-1", "1.5", ""]) {
			const env = clientEnv();
			const d = deps(() => ({ ok: true, data: { text: "x" } }));

			expect(await runExt(["--ext", `--tab=${value}`, "snapshot"], env, d.value)).toBe(2);
			expect(env.stderr.join("\n")).toContain(TAB_USAGE);
			expect(d.sent).toEqual([]);
		}
	});

	test.each([
		[["select", "abc"]],
		[["select", "1.5"]],
		[["close", "abc"]],
		[["select"]],
		[["--tab", "3", "tabs"]],
		[["--tab", "3", "new"]],
		[["--tab", "3", "new", "https://a.example"]],
		[["select", "3", "--tab", "4"]],
		[["select", "--tab", "4"]],
		[["close", "3", "--tab", "4"]],
		[["tabs", "extra"]],
		[["new", "https://a.example", "extra"]],
		[["select", "1", "2"]],
		[["close", "1", "2"]],
		[["new", "chrome://settings"]],
		[["new", "javascript:alert(1)"]],
	])("refuses %p with exit 2 and sends nothing", async (argv) => {
		const env = clientEnv();
		const d = deps(() => ({ ok: true, data: { text: "x" } }));

		expect(await runExt(["--ext", ...argv], env, d.value)).toBe(2);
		expect(d.sent).toEqual([]);
		expect(env.stderr.join("\n")).not.toBe("");
	});

	test.each([
		[["--tab", "3", "tabs"], "pw --ext tabs does not take --tab."],
		[["--tab", "3", "new"], "pw --ext new does not take --tab."],
		[
			["select", "3", "--tab", "4"],
			"pw --ext select takes a tab id, not --tab.",
		],
		[["select", "--tab", "4"], "pw --ext select takes a tab id, not --tab."],
		[["--tab", "4", "select"], "pw --ext select takes a tab id, not --tab."],
		[
			["close", "3", "--tab", "4"],
			"pw --ext close takes a tab id or --tab, not both.",
		],
	])("prints the exact usage text for %p", async (argv, text) => {
		const env = clientEnv();
		await runExt(["--ext", ...argv], env, deps(() => ({})).value);

		expect(env.stderr.join("\n")).toContain(text);
	});

	test("states the optional and required positionals in the arity message", async () => {
		const env = clientEnv();
		await runExt(["--ext", "new", "a", "b"], env, deps(() => ({})).value);

		expect(env.stderr.join("\n")).toContain("pw --ext new takes [<url>].");
	});

	test("lists all 16 verbs for an unknown verb", async () => {
		const env = clientEnv();
		await runExt(["--ext", "nope"], env, deps(() => ({})).value);
		const verbs = [...PW_EXT_READ_VERBS, ...PW_EXT_WRITE_VERBS];

		expect(verbs).toHaveLength(16);
		for (const verb of verbs) expect(env.stderr.join("\n")).toContain(verb);
		expect(env.stderr.join("\n")).toContain(`Use one of: ${verbs.join(", ")}.`);
	});

	test("does not tell a user with an unknown flag that no other flags exist", async () => {
		const env = clientEnv();
		await runExt(["--ext", "--bogus", "snapshot"], env, deps(() => ({})).value);

		expect(env.stderr.join("\n")).not.toContain("takes no other flags");
	});

	test("lists the four tab verbs and --tab in help", async () => {
		const env = clientEnv();
		await runExt(["--ext", "--help"], env, deps(() => ({})).value);
		const help = env.stdout.join("\n");

		for (const verb of ["tabs", "new", "select", "close"]) expect(help).toContain(verb);
		expect(help).toContain("--tab");
		expect(help).toContain("the agent's selected tab");
		expect(help).not.toContain("active tab");
		expect(help).not.toContain("takes no other flags");
	});
});

describe("pw main routes --ext", () => {
	test("never starts a local browser session for --ext", async () => {
		const env = clientEnv();
		expect(await main(["--ext", "eval", "1"], env)).toBe(2);
		expect(env.stderr.join("\n")).toContain("eval");
	});
});

const VISIBLE_TMP = "/tmp";

describe("pw --ext round 3", () => {
	function workdir(): string {
		const dir = mkdtempSync(join(VISIBLE_TMP, "pw-ext-cwd-"));
		dirs.push(dir);
		return dir;
	}
	const dirs: string[] = [];
	afterEachCleanup(dirs);

	test("stages a file from the working directory and sends an upload", async () => {
		const cwd = workdir();
		writeFileSync(join(cwd, "demo.txt"), "hello");
		const env = clientEnv(cwd);
		const d = deps(() => ({ ok: true, data: { text: "uploaded" } }));
		expect(await runExt(["--ext", "upload", "#file", "demo.txt"], env, d.value)).toBe(0);
		expect(d.posted).toEqual([{ name: "demo.txt", bytes: "hello" }]);
		expect(d.sent[0]?.request).toEqual({
			verb: "upload",
			target: "#file",
			assetId: "123e4567-e89b-42d3-a456-426614174000",
			fileName: "demo.txt",
			fileSize: 5,
			fileType: "text/plain",
			filePath: join(cwd, "demo.txt").replace(homedir(), "~"),
		});
	});

	test("stages a file from the pw scratch directory", async () => {
		writeFileSync(join(scratch.dir, "shot.png"), "png");
		const d = deps(() => ({ ok: true, data: { text: "uploaded" } }));
		expect(
			await runExt(["--ext", "upload", "#f", join(scratch.dir, "shot.png")], clientEnv(workdir()), d.value),
		).toBe(0);
		expect(d.sent[0]?.request).toMatchObject({ fileName: "shot.png", fileType: "image/png" });
	});

	test("stages a recorded demo from the dg demos directory", async () => {
		const { demosDir } = await import("../../src/demo/paths");
		mkdirSync(join(demosDir(), "tour"), { recursive: true });
		writeFileSync(join(demosDir(), "tour", "tour.webm"), "webm");
		const d = deps(() => ({ ok: true, data: { text: "uploaded" } }));
		expect(
			await runExt(
				["--ext", "upload", "#f", join(demosDir(), "tour", "tour.webm")],
				clientEnv(workdir()),
				d.value,
			),
		).toBe(0);
		expect(d.sent[0]?.request).toMatchObject({ fileName: "tour.webm", fileSize: 4 });
	});

	test.each([
		["outside", (cwd: string, outside: string) => join(outside, "x.txt")],
		["a directory", (cwd: string) => cwd],
		["a symlink", (cwd: string, outside: string) => {
			symlinkSync(join(outside, "x.txt"), join(cwd, "link.txt"));
			return join(cwd, "link.txt");
		}],
		["a symlinked folder", (cwd: string, outside: string) => {
			symlinkSync(outside, join(cwd, "out"));
			return join(cwd, "out", "x.txt");
		}],
		["missing", (cwd: string) => join(cwd, "nope.txt")],
	])("refuses a file that is %s and sends nothing", async (_label, pick) => {
		const cwd = workdir();
		const outside = workdir();
		writeFileSync(join(outside, "x.txt"), "secret");
		mkdirSync(join(cwd, "sub"));
		const env = clientEnv(cwd);
		const d = deps(() => ({ ok: true, data: { text: "x" } }));
		expect(await runExt(["--ext", "upload", "#f", pick(cwd, outside)], env, d.value)).toBe(2);
		expect(d.posted).toEqual([]);
		expect(d.sent).toEqual([]);
	});

	test("refuses hidden files and folders such as .ssh or .env", async () => {
		const cwd = workdir();
		mkdirSync(join(cwd, ".ssh"));
		writeFileSync(join(cwd, ".ssh", "id_ed25519"), "key");
		writeFileSync(join(cwd, ".env"), "TOKEN=x");
		for (const file of [".ssh/id_ed25519", ".env"]) {
			const d = deps(() => ({ ok: true, data: { text: "x" } }));
			expect(await runExt(["--ext", "upload", "#f", file], clientEnv(cwd), d.value)).toBe(2);
			expect(d.posted).toEqual([]);
		}
	});

	test("does not treat the home directory as an upload root", async () => {
		const fencedHome = process.env.HOME as string;
		expect(fencedHome).not.toBe(homedir());
		writeFileSync(join(fencedHome, "notes.txt"), "x");
		const d = deps(() => ({ ok: true, data: { text: "x" } }));
		expect(
			await runExt(["--ext", "upload", "#f", "notes.txt"], clientEnv(fencedHome), d.value),
		).toBe(2);
		expect(d.posted).toEqual([]);
	});

	test("refuses a working directory inside a hidden folder of the home", async () => {
		const fencedHome = process.env.HOME as string;
		const hidden = join(fencedHome, ".ssh");
		mkdirSync(hidden, { recursive: true });
		writeFileSync(join(hidden, "id_ed25519"), "key");
		const d = deps(() => ({ ok: true, data: { text: "x" } }));
		expect(
			await runExt(["--ext", "upload", "#f", "id_ed25519"], clientEnv(hidden), d.value),
		).toBe(2);
		expect(d.posted).toEqual([]);
	});

	test("refuses a hidden working directory outside the home", async () => {
		const hidden = join(workdir(), ".private");
		mkdirSync(hidden);
		writeFileSync(join(hidden, "notes.txt"), "x");
		const d = deps(() => ({ ok: true, data: { text: "x" } }));
		expect(
			await runExt(["--ext", "upload", "#f", "notes.txt"], clientEnv(hidden), d.value),
		).toBe(2);
		expect(d.posted).toEqual([]);
	});

	test("maps tools and call", async () => {
		const d = deps(() => ({ ok: true, data: { text: "ok" } }));
		expect(await runExt(["--ext", "tools"], clientEnv(), d.value)).toBe(0);
		expect(await runExt(["--ext", "call", "search", '{"q":"bug"}'], clientEnv(), d.value)).toBe(0);
		expect(d.sent.map((frame) => frame.request)).toEqual([
			{ verb: "tools" },
			{ verb: "call", tool: "search", args: { q: "bug" } },
		]);
	});

	test.each([["not json"], ["[1]"], ['"x"'], ["null"]])(
		"refuses call args %p",
		async (args) => {
			const d = deps(() => ({ ok: true, data: { text: "ok" } }));
			expect(await runExt(["--ext", "call", "search", args], clientEnv(), d.value)).toBe(2);
			expect(d.sent).toEqual([]);
		},
	);

	test("sends a cancel and exits 130 when interrupted", async () => {
		const env = clientEnv();
		let release: (() => void) | undefined;
		const d = deps(() => ({ ok: true, data: { text: "late" } }));
		const pending = deps(() => ({}));
		const client: ExtClient = {
			request: () =>
				new Promise((_, reject) => {
					release = () => reject(new Error("closed"));
				}),
			send: (frame) => d.cancels.push(frame),
			postAsset: async () => "",
			close: () => release?.(),
		};
		const run = runExt(["--ext", "click", "e1"], env, {
			...d.value,
			connect: async () => client,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		d.interrupt();
		expect(await run).toBe(130);
		expect(d.cancels).toEqual([
			{ type: "cli-pw-ext-cancel", requestId: expect.any(String) },
		]);
		expect(pending.sent).toEqual([]);
	});
});

function afterEachCleanup(dirs: string[]) {
	const { afterEach } = require("bun:test") as typeof import("bun:test");
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
}
