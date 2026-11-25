import { describe, expect, test } from "bun:test";
import type { PwExtCliRequest } from "@dg/common";
import { extensionConnected, main } from "../../src/pw/cli";
import { type ExtClient, type ExtDeps, runExt } from "../../src/pw/ext";
import { clientEnv, startFakeDaemon, useTempScratch } from "../../src/pw/test-support";

useTempScratch();

function relay(text = "### Result\ndone") {
	const sent: PwExtCliRequest[] = [];
	const connects: (string | undefined)[] = [];
	const client: ExtClient = {
		send: () => undefined,
		postAsset: async () => "",
		async request(frame, accept) {
			sent.push(frame as PwExtCliRequest);
			const answer = {
				type: "cli-pw-ext-result",
				sessionId: "s1",
				requestId: (frame as PwExtCliRequest).requestId,
				ok: true,
				data: { text },
			};
			if (!accept(answer)) throw new Error("reply not accepted");
			return answer;
		},
		close: () => undefined,
	};
	const deps: ExtDeps = {
		connect: async (session) => {
			connects.push(session);
			return client;
		},
		cliOnly: () => false,
		onInterrupt: () => () => undefined,
	};
	return { deps, connects, requests: () => sent.map((frame) => frame.request) };
}

describe("pw --ext module verbs", () => {
	test.each([
		[["go-back"], { verb: "go-back" }],
		[["reload", "--tab", "4"], { verb: "reload", tabId: 4 }],
		[["hover", "e1"], { verb: "hover", target: "e1" }],
		[["drag", "e1", "e2"], { verb: "drag", target: "e1", to: "e2" }],
		[["mousemove", "10", "20"], { verb: "mousemove", x: 10, y: 20 }],
		[["mousedown", "right"], { verb: "mousedown", button: "right" }],
		[["mousewheel", "0", "-100"], { verb: "mousewheel", dx: 0, dy: -100 }],
		[["check", "e1"], { verb: "check", target: "e1" }],
		[["type", "hello"], { verb: "type", text: "hello" }],
		[["type", "hello", "--submit"], { verb: "type", text: "hello", submit: true }],
		[["keydown", "Shift"], { verb: "keydown", key: "Shift" }],
		[["eval", "1 + 1"], { verb: "eval", expression: "1 + 1" }],
		[["eval", "1 + 1", "--tab", "3"], { verb: "eval", expression: "1 + 1", tabId: 3 }],
		[["tab-select", "5"], { verb: "tab-select", tabId: 5 }],
		[["resize", "800", "600"], { verb: "resize", width: 800, height: 600 }],
		[["localstorage-set", "a", "b"], { verb: "localstorage-set", key: "a", value: "b" }],
		[["sessionstorage-delete", "a"], { verb: "sessionstorage-delete", key: "a" }],
		[["sessionstorage-clear"], { verb: "sessionstorage-clear" }],
	])("sends %j as one relay request", async (argv, request) => {
		const r = relay();
		const env = clientEnv();
		expect(await runExt(["--ext", ...argv], env, r.deps)).toBe(0);
		expect(r.requests()).toEqual([request as never]);
		expect(env.stdout).toEqual(["### Result\ndone"]);
	});

	test("passes --session to the connection", async () => {
		const r = relay();
		await runExt(["--ext", "--session", "s9", "reload"], clientEnv(), r.deps);
		expect(r.connects).toEqual(["s9"]);
	});

	test.each([
		[["go-back", "extra"]],
		[["hover"]],
		[["mousemove", "x", "1"]],
		[["check"]],
		[["click", "e1", "--submit"]],
		[["eval"]],
		[["resize", "10", "10"]],
		[["tab-select", "5", "--tab", "1"]],
		[["localstorage-set", "a"]],
	])("refuses %j with exit 2 before it connects", async (argv) => {
		const r = relay();
		const env = clientEnv();
		expect(await runExt(["--ext", ...argv], env, r.deps)).toBe(2);
		expect(r.connects).toEqual([]);
		expect(env.stderr.join("\n")).toContain("pw --ext");
	});

	test("masks secret-shaped values in the printed result", async () => {
		const r = relay("### Result\nvisited https://x.test/?token=zzzzzzzzzzzz");
		const env = clientEnv();
		await runExt(["--ext", "eval", "location.href"], env, r.deps);
		expect(env.stdout.join("\n")).not.toContain("zzzzzzzzzzzz");
	});

	test("lists the new verbs in the help", async () => {
		const env = clientEnv();
		await runExt(["--ext", "--help"], env, relay().deps);
		for (const verb of ["go-back", "hover", "mousewheel", "check", "keydown", "eval", "resize", "localstorage-set"])
			expect(env.stdout.join("\n")).toContain(verb);
	});
});

describe("pw auto mode with a paired extension", () => {
	const never = [] as const;

	test("runs open, click, fill, back, reload, hover and eval through the extension and never starts Playwright", async () => {
		const seen: string[] = [];
		const daemon = await startFakeDaemon("web", {}, (request) => {
			seen.push(request.method);
			return { text: "local", exitCode: 0 };
		});
		const r = relay();
		try {
			for (const argv of [
				["goto", "https://x.test/"],
				["click", "e1"],
				["fill", "e1", "hello"],
				["go-back"],
				["reload"],
				["hover", "e1"],
				["eval", "document.title"],
			]) {
				const env = clientEnv();
				expect(await main(argv, env, never, async () => true, r.deps)).toBe(0);
				expect(env.stdout).toEqual(["### Result\ndone"]);
			}
			expect(r.requests().map((request) => request.verb)).toEqual([
				"open",
				"click",
				"fill",
				"go-back",
				"reload",
				"hover",
				"eval",
			]);
			expect(seen).toEqual([]);
		} finally {
			daemon.dispose();
		}
	});

	test("falls back to local for a call with -s or --session instead of erroring", async () => {
		const seen: string[] = [];
		const daemon = await startFakeDaemon("web", {}, (request) => {
			seen.push(request.method);
			return { text: "clicked", exitCode: 0 };
		});
		const r = relay();
		try {
			for (const argv of [
				["-s=web", "click", "e1"],
				["--session=web", "click", "e1"],
			]) {
				const env = clientEnv();
				expect(await main(argv, env, undefined, async () => true, r.deps)).toBe(0);
			}
			expect(seen).toEqual(["run", "run"]);
			expect(r.connects).toEqual([]);
		} finally {
			daemon.dispose();
		}
	});

	test("does not probe the extension for a call it cannot send", async () => {
		const daemon = await startFakeDaemon("web", {}, () => ({ text: "ok", exitCode: 0 }));
		let probed = 0;
		try {
			await main(["-s=web", "tab-close", "2"], clientEnv(), undefined, async () => (probed++, true), relay().deps);
			expect(probed).toBe(0);
		} finally {
			daemon.dispose();
		}
	});
});

describe("extensionConnected", () => {
	const live = async () => ({});

	test("is true only for a session plus a connected extension", async () => {
		expect(await extensionConnected({ session: live, version: async () => "1.60.0" })).toBe(true);
	});

	test("is false when the daemon has a session but no extension has connected", async () => {
		expect(await extensionConnected({ session: live, version: async () => null })).toBe(false);
	});

	test("is false without a session and does not ask the daemon about the extension", async () => {
		let asked = false;
		const probe = {
			session: async () => {
				throw new Error("no session");
			},
			version: async () => ((asked = true), "1.60.0"),
		};
		expect(await extensionConnected(probe)).toBe(false);
		expect(asked).toBe(false);
	});
});
