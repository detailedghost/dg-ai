import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decisionPath, reloadPath, selectionPath } from "../../src/prototype/paths";
import { type BoundPrototypeServer, startPrototypeServer } from "../../src/prototype/serve";

const cleanupDirs: string[] = [];
const liveServers: BoundPrototypeServer[] = [];
let originalScratchDir: string | undefined;

function freshDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

beforeEach(() => {
	originalScratchDir = process.env.AI_SCRATCH_DIR;
	process.env.AI_SCRATCH_DIR = freshDir("proto-serve-scratch-");
});

afterEach(() => {
	for (const server of liveServers.splice(0)) server.stop();
	if (originalScratchDir === undefined) delete process.env.AI_SCRATCH_DIR;
	else process.env.AI_SCRATCH_DIR = originalScratchDir;
	for (const dir of cleanupDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

let portCounter = 5900;
function nextPort(): number {
	portCounter += 7;
	return portCounter;
}

async function launch(name: string, html = "<!doctype html><html><head></head><body>test</body></html>") {
	const cwd = freshDir("proto-serve-cwd-");
	const htmlPath = join(cwd, `${name}.html`);
	writeFileSync(htmlPath, html);
	const server = await startPrototypeServer(htmlPath, name, { light: true, cwd, port: nextPort() });
	liveServers.push(server);
	return { server, cwd, htmlPath };
}

describe("startPrototypeServer /prototype-decision", () => {
	test("confirm writes the .selection sentinel", async () => {
		const { server, cwd } = await launch("regress-confirm");

		const res = await fetch(`http://127.0.0.1:${server.port}/prototype-decision`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "regress-confirm", action: "confirm", variant: "A", notes: "" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		const sentinelPath = await selectionPath("regress-confirm", { light: true, cwd });
		expect(existsSync(sentinelPath)).toBe(true);
		expect(readFileSync(sentinelPath, "utf8").trim()).toBe("A");
	});

	test("reject writes the .reject sentinel with notes", async () => {
		const { server, cwd } = await launch("regress-reject");

		const res = await fetch(`http://127.0.0.1:${server.port}/prototype-decision`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "regress-reject", action: "reject", notes: "wrong direction" }),
		});

		expect(res.status).toBe(200);
		const sentinelPath = await selectionPath("regress-reject", { light: true, cwd });
		const rejectPath = join(sentinelPath, "..", ".reject");
		expect(existsSync(rejectPath)).toBe(true);
		expect(readFileSync(rejectPath, "utf8")).toBe("wrong direction");
	});

	test("confirm rejects a variant outside the allowed list", async () => {
		const { server } = await launch("regress-badvariant");

		const res = await fetch(`http://127.0.0.1:${server.port}/prototype-decision`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "regress-badvariant", action: "confirm", variant: "Z", variants: ["A", "B"] }),
		});

		expect(res.status).toBe(400);
	});

	test("plan decision writes the .decision sentinel", async () => {
		const { server, cwd } = await launch("regress-decision");

		const res = await fetch(`http://127.0.0.1:${server.port}/prototype-decision`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "regress-decision", decision: "rework", notes: "fix the nav" }),
		});

		expect(res.status).toBe(200);
		const path = await decisionPath("regress-decision", { light: true, cwd });
		const raw = readFileSync(path, "utf8");
		expect(JSON.parse(raw)).toEqual({ decision: "REWORK", notes: "fix the nav" });
	});
});

describe("startPrototypeServer GET routes", () => {
	test("serves the html file with the decision-bar script injected", async () => {
		const { server } = await launch("regress-get");
		const res = await fetch(`http://127.0.0.1:${server.port}/`);
		const body = await res.text();
		expect(body).toContain("window.prototypeDecide");
		expect(body).toContain("window.prototypePlanDecision");
	});

	test("reload endpoint reports 0 until a token is written, then the written token", async () => {
		const { server, cwd } = await launch("regress-reload");
		const before = await (await fetch(`http://127.0.0.1:${server.port}/prototype-reload`)).json();
		expect(before).toEqual({ token: "0" });

		const path = await reloadPath("regress-reload", { light: true, cwd });
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "42\n");
		const after = await (await fetch(`http://127.0.0.1:${server.port}/prototype-reload`)).json();
		expect(after).toEqual({ token: "42" });
	});

	test("changes endpoint returns {} when no sidecar has been written", async () => {
		const { server } = await launch("regress-changes");
		const res = await (await fetch(`http://127.0.0.1:${server.port}/prototype-changes`)).json();
		expect(res).toEqual({});
	});

	test("rejects a non-localhost Host header", async () => {
		const { server } = await launch("regress-host");
		const res = await fetch(`http://127.0.0.1:${server.port}/`, {
			headers: { Host: "evil.example.com" },
		});
		expect(res.status).toBe(403);
	});
});
