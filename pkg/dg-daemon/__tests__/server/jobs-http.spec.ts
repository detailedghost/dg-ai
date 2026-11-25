import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CHAT_JOBS_PATH,
	DG_CHROME_EXTENSION_ORIGIN,
} from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	bootServe,
	cleanupDgHome,
	createCleanupSlot,
	ownerTokenHeader,
	stopServe,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();
afterEach(() => cleanupSlot.run());

const botDecl = (cwd: string) => ({
	bot: {
		argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
		cwd,
		continuous: true,
	},
});

async function boot(config: (dgHome: string) => Record<string, unknown>) {
	const { dgHome, port, proc } = await bootServe();
	cleanupSlot.set(async () => {
		await call(port, CHAT_JOBS_PATH, "bot/stop", "POST");
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	const { daemonConfigPath } = resolveDgPaths({ env: { DG_HOME: dgHome } });
	mkdirSync(join(daemonConfigPath, ".."), { recursive: true });
	writeFileSync(daemonConfigPath, JSON.stringify(config(dgHome)));
	return { dgHome, port };
}

function call(
	port: number,
	base: string,
	path: string,
	method: "GET" | "POST",
	headers: Record<string, string> = { Origin: DG_CHROME_EXTENSION_ORIGIN },
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${base}${path ? `/${path}` : ""}`, {
		method,
		headers: { Host: `127.0.0.1:${port}`, ...headers },
	});
}

describe("GET /jobs", () => {
	it("answers the instance id and the job status objects under jobs", async () => {
		const { port } = await boot((home) => ({ jobs: botDecl(home) }));
		const body = await (await call(port, CHAT_JOBS_PATH, "", "GET")).json();
		const health = await (
			await fetch(`http://127.0.0.1:${port}/healthz`)
		).json();
		expect(body.instanceId).toBe(health.instanceId);
		expect(body.jobs).toHaveLength(1);
		expect(body.jobs[0]).toMatchObject({ label: "bot", state: "stopped" });
	});

	it.each([
		["GET", ""],
		["GET", "/bot"],
		["POST", "/bot/start"],
		["POST", "/bot/stop"],
	] as const)("answers 404 for %s /services%s", async (method, tail) => {
		const { port } = await boot((home) => ({ jobs: botDecl(home) }));
		const resp = await fetch(`http://127.0.0.1:${port}/services${tail}`, {
			method,
			headers: { Host: `127.0.0.1:${port}`, ...ownerTokenHeader(port) },
		});
		expect(resp.status).toBe(404);
	});

	it("refuses a request with no origin and no credential", async () => {
		const { port } = await boot((home) => ({ jobs: botDecl(home) }));
		const resp = await call(port, CHAT_JOBS_PATH, "", "GET", {});
		expect(resp.status).toBe(403);
		expect(await resp.text()).not.toContain("bot");
	});

	it("accepts the owner credential with no origin", async () => {
		const { port } = await boot((home) => ({ jobs: botDecl(home) }));
		const resp = await call(
			port,
			CHAT_JOBS_PATH,
			"",
			"GET",
			ownerTokenHeader(port),
		);
		expect(resp.status).toBe(200);
	});

	it("refuses a Host that is not the loopback authority", async () => {
		const { port } = await boot((home) => ({ jobs: botDecl(home) }));
		const resp = await fetch(`http://127.0.0.1:${port}${CHAT_JOBS_PATH}`, {
			headers: { Host: "evil.example" },
		});
		expect(resp.status).toBe(400);
	});
});

describe("POST /jobs/<name>/start and /stop", () => {
	it("starts and stops a continuous job, and answers 409 for a second start", async () => {
		const { port } = await boot((home) => ({ jobs: botDecl(home) }));
		const started = await call(port, CHAT_JOBS_PATH, "bot/start", "POST");
		expect(started.status).toBe(200);
		expect(await started.json()).toMatchObject({
			label: "bot",
			state: "running",
		});
		const again = await call(port, CHAT_JOBS_PATH, "bot/start", "POST");
		expect(again.status).toBe(409);
		const stopped = await call(port, CHAT_JOBS_PATH, "bot/stop", "POST");
		expect(await stopped.json()).toMatchObject({ state: "stopped" });
	});

	it("answers 404 with the job text for an unknown name on /jobs", async () => {
		const { port } = await boot(() => ({}));
		for (const verb of ["start", "stop"]) {
			const resp = await call(port, CHAT_JOBS_PATH, `nope/${verb}`, "POST");
			expect(resp.status).toBe(404);
			expect((await resp.text()).trim()).toBe('no job named "nope"');
		}
	});

	it("refuses a browser page origin and starts nothing", async () => {
		const { port } = await boot((home) => ({ jobs: botDecl(home) }));
		const resp = await call(port, CHAT_JOBS_PATH, "bot/start", "POST", {
			Origin: "https://evil.example",
		});
		expect(resp.status).toBe(400);
		const listed = await (await call(port, CHAT_JOBS_PATH, "", "GET")).json();
		expect(listed.jobs[0].state).toBe("stopped");
	});

	it("answers 400 for a malformed percent-encoded name", async () => {
		const { port } = await boot((home) => ({ jobs: botDecl(home) }));
		const resp = await call(port, CHAT_JOBS_PATH, "%E0%A4%A/start", "POST");
		expect(resp.status).toBe(400);
	});

	it("refuses a start with no credential", async () => {
		const { port } = await boot((home) => ({ jobs: botDecl(home) }));
		const resp = await call(port, CHAT_JOBS_PATH, "bot/start", "POST", {});
		expect(resp.status).toBe(403);
	});
});

describe("a scheduled entry beside a continuous one", () => {
	it("is listed by the job route as a scheduled job, which the supervisor does not start", async () => {
		const { port } = await boot((home) => ({
			jobs: {
				...botDecl(home),
				tick: { argv: ["/bin/true"], cwd: home, every: "15m" },
			},
		}));
		const listed = await (await call(port, CHAT_JOBS_PATH, "", "GET")).json();
		expect(
			listed.jobs.map((job: { label: string; state: string }) => [
				job.label,
				job.state,
			]),
		).toEqual([
			["bot", "stopped"],
			["tick", "disabled"],
		]);
	});
});
