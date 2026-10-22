import { describe, expect, test } from "bun:test";
import { CODE_HELP, main } from "../src/pw/code-cli";
import type { DaemonRequest } from "../src/pw/core/socket";
import { clientEnv, startFakeDaemon, useTempScratch } from "../src/pw/test-support";

useTempScratch();

async function withDaemon(reply: { text: string; exitCode: number }) {
	const seen: DaemonRequest[] = [];
	const daemon = await startFakeDaemon("web", {}, (request) => {
		seen.push(request);
		return reply;
	});
	return { seen, daemon };
}

describe("pw-code", () => {
	test("sends the code to the daemon with the code method", async () => {
		const { seen, daemon } = await withDaemon({ text: "### Result\n1", exitCode: 0 });
		try {
			const env = clientEnv("/w");
			expect(await main(["-s=web", "async (page) => 1"], env)).toBe(0);
			expect(env.stdout).toEqual(["### Result\n1"]);
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({
				method: "code",
				params: { argv: ["run-code", "--session=web", "async (page) => 1"], cwd: "/w", raw: false },
			});
		} finally {
			daemon.dispose();
		}
	});

	test("passes --raw and --filename through", async () => {
		const { seen, daemon } = await withDaemon({ text: "1", exitCode: 0 });
		try {
			expect(await main(["-s=web", "--raw", "--filename=snippet.js"], clientEnv("/w"))).toBe(0);
			expect(seen[0]).toMatchObject({
				method: "code",
				params: { argv: ["run-code", "--session=web", "--raw", "--filename=snippet.js"], raw: true },
			});
		} finally {
			daemon.dispose();
		}
	});

	test("relays a failing result to stderr with its exit code", async () => {
		const { daemon } = await withDaemon({ text: "### Error\nboom", exitCode: 1 });
		try {
			const env = clientEnv();
			expect(await main(["-s=web", "async (page) => { throw new Error('boom'); }"], env)).toBe(1);
			expect(env.stderr).toEqual(["### Error\nboom"]);
		} finally {
			daemon.dispose();
		}
	});

	test("asks for code or a filename before it contacts a browser", async () => {
		const env = clientEnv();
		expect(await main(["-s=web"], env)).toBe(2);
		expect(env.stderr[0]).toContain("Provide the code as an argument or with --filename");
	});

	test("rejects an option it does not know", async () => {
		const env = clientEnv();
		expect(await main(["--cdp=x", "async (page) => 1"], env)).toBe(2);
		expect(env.stderr[0]).toContain("Unknown option: --cdp");
	});

	test("says the browser is not open when no session exists", async () => {
		const env = clientEnv();
		expect(await main(["-s=nothing", "async (page) => 1"], env)).toBe(1);
		expect(env.stderr).toEqual(["Browser 'nothing' is not open. Run: pw open"]);
	});

	test("prints help and the approval note", async () => {
		const env = clientEnv();
		expect(await main(["--help"], env)).toBe(0);
		expect(env.stdout).toEqual([CODE_HELP]);
		expect(CODE_HELP).toContain("asks you before every run");
	});
});
