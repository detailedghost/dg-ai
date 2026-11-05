import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import type { PwExtCliRequest } from "@dg/common";
import { main } from "../../src/pw/cli";
import { type ExtClient, type ExtDeps, runExt } from "../../src/pw/ext";
import { clientEnv, useTempScratch } from "../../src/pw/test-support";

const scratch = useTempScratch();

function deps(
	reply: (frame: PwExtCliRequest) => Record<string, unknown>,
	overrides: Partial<ExtDeps> = {},
) {
	const sent: PwExtCliRequest[] = [];
	let closed = false;
	const client: ExtClient = {
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
		...overrides,
	};
	return { value, sent, closed: () => closed };
}

describe("pw --ext", () => {
	test("sends one verb and prints the redacted text", async () => {
		const env = clientEnv();
		const d = deps(() => ({
			ok: true,
			data: { text: "### Page\n- Page URL: https://x.test/?token=abcdef123456" },
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
		expect(env.stdout.join("\n")).not.toContain("abcdef123456");
		expect(d.closed()).toBe(true);
	});

	test.each([
		[["open", "https://example.test/"], { verb: "open", url: "https://example.test/" }],
		[["click", "e3"], { verb: "click", target: "e3" }],
		[["fill", "#q", "cats"], { verb: "fill", target: "#q", value: "cats" }],
		[["current"], { verb: "current" }],
		[["selection"], { verb: "selection" }],
		[["console"], { verb: "console" }],
	])("maps %p to %p", async (argv, request) => {
		const d = deps(() => ({ ok: true, data: { text: "ok" } }));
		expect(await runExt(["--ext", ...argv], clientEnv(), d.value)).toBe(0);
		expect(d.sent[0]?.request).toEqual(request as never);
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
	});
});

describe("pw main routes --ext", () => {
	test("never starts a local browser session for --ext", async () => {
		const env = clientEnv();
		expect(await main(["--ext", "eval", "1"], env)).toBe(2);
		expect(env.stderr.join("\n")).toContain("eval");
	});
});
