import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wait } from "@dg/common";
import { isAlive } from "@dg/common/node";
import {
	disposeRigs,
	IGNORE_SIGTERM,
	rig,
	SLEEPER,
	scratchDir,
	until,
} from "./supervisor-kit";

afterEach(disposeRigs);

const READY = "console.log('ready');";

const botDecl = (source: string, extra: Record<string, unknown> = {}) =>
	rig(({ root, script }) => ({
		bot: { argv: script(source), cwd: root, ...extra },
	}));

const logText = (logFile: string) =>
	existsSync(logFile) ? readFileSync(logFile, "utf8") : "";

function recordSignals() {
	const calls: Array<{ pid: number; signal: unknown }> = [];
	const real = process.kill.bind(process);
	const spy = spyOn(process, "kill").mockImplementation(((
		pid: number,
		signal?: string | number,
	) => {
		if (signal !== 0 && signal !== undefined) calls.push({ pid, signal });
		return real(pid, signal as never);
	}) as typeof process.kill);
	return { calls, restore: () => spy.mockRestore() };
}

describe("supervisor stop grace period", () => {
	it("ends a child that ignores SIGTERM with SIGKILL after stopTimeoutMs", async () => {
		const r = botDecl(`process.on("SIGTERM", () => {}); ${READY} ${SLEEPER}`, {
			stopTimeoutMs: 300,
		});
		r.supervisor.start("bot");
		await until(() => logText(r.logFile).includes("ready"));

		const startedAt = Date.now();
		await r.supervisor.stop("bot");
		const elapsed = Date.now() - startedAt;

		expect(r.status().lastExit).toBe("killed by SIGKILL");
		expect(elapsed).toBeGreaterThanOrEqual(300);
		expect(elapsed).toBeLessThan(3000);
	});

	it("resolves stop fast for a child that exits on SIGTERM despite a long stopTimeoutMs", async () => {
		const r = botDecl(`${READY} ${SLEEPER}`, { stopTimeoutMs: 240_000 });
		r.supervisor.start("bot");
		await until(() => logText(r.logFile).includes("ready"));

		const startedAt = Date.now();
		await r.supervisor.stop("bot");

		expect(Date.now() - startedAt).toBeLessThan(3000);
	});

	it("sends SIGTERM once and no later signal to a service that exited on SIGTERM", async () => {
		const r = botDecl(`${READY} ${SLEEPER}`, { stopTimeoutMs: 300 });
		r.supervisor.start("bot");
		await until(() => logText(r.logFile).includes("ready"));
		const pid = r.status().pid as number;

		const recorder = recordSignals();
		try {
			await r.supervisor.stop("bot");
			await wait(500);
		} finally {
			recorder.restore();
		}
		const toService = recorder.calls.filter(
			(c) => c.pid === pid || c.pid === -pid,
		);
		expect(toService.map((c) => c.signal)).toEqual(["SIGTERM"]);
		expect(toService[0]?.pid).toBe(-pid);
	});

	it("sends SIGTERM to the group of the second run after a crash and restart", async () => {
		const runs = scratchDir("dg-runs-");
		const counter = join(runs, "runs");
		const r = botDecl(
			`const fs = require("node:fs");
			fs.appendFileSync(${JSON.stringify(counter)}, "x");
			if (fs.readFileSync(${JSON.stringify(counter)}, "utf8").length === 1) process.exit(1);
			${READY} ${SLEEPER}`,
			{ stopTimeoutMs: 300 },
		);
		r.supervisor.start("bot");
		await until(
			() => r.status().restarts >= 1 && logText(r.logFile).includes("ready"),
		);
		const secondPid = r.status().pid as number;

		const recorder = recordSignals();
		try {
			await r.supervisor.stop("bot");
		} finally {
			recorder.restore();
		}
		expect(
			recorder.calls.filter(
				(c) => c.pid === -secondPid && c.signal === "SIGTERM",
			),
		).toHaveLength(1);
		expect(isAlive(secondPid)).toBe(false);
		expect(r.status().state).toBe("stopped");
	});

	it("returns the stopped status when stopping a declared service that never ran", async () => {
		const r = botDecl(SLEEPER);
		const result = await r.supervisor.stop("bot");
		expect(result).toMatchObject({ ok: true, status: { state: "stopped" } });
	});
});

describe("supervisor status after a declaration is removed", () => {
	it("lists a stopped service while declared and drops it once it is no longer declared", async () => {
		let declared = true;
		const r = rig(({ root, script }) =>
			declared ? { bot: { argv: script(SLEEPER), cwd: root } } : {},
		);
		r.supervisor.start("bot");
		await until(() => r.status().pid !== null);
		await r.supervisor.stop("bot");
		expect(r.supervisor.status().map((entry) => entry.label)).toEqual(["bot"]);

		declared = false;

		expect(r.supervisor.status()).toEqual([]);
	});

	it("keeps listing a running service whose declaration was removed", async () => {
		let declared = true;
		const r = rig(({ root, script }) =>
			declared ? { bot: { argv: script(SLEEPER), cwd: root } } : {},
		);
		r.supervisor.start("bot");
		await until(() => r.status().pid !== null);

		declared = false;

		expect(
			r.supervisor.status().map((entry) => [entry.label, entry.state]),
		).toEqual([["bot", "running"]]);
	});
});

describe("supervisor crash with a surviving child", () => {
	const crashLeavingStubbornChild = (pidsFile: string, counter: string) => `
		const fs = require("node:fs");
		const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(IGNORE_SIGTERM)}]);
		fs.appendFileSync(${JSON.stringify(pidsFile)}, child.pid + "\\n");
		fs.appendFileSync(${JSON.stringify(counter)}, "x");
		if (fs.readFileSync(${JSON.stringify(counter)}, "utf8").length === 1) {
			setTimeout(() => process.exit(1), 150);
		} else {
			${SLEEPER}
		}`;

	it("kills the leftover child before the next start and delays the restart by stopTimeoutMs at most", async () => {
		const dir = scratchDir("dg-crash-");
		const pidsFile = join(dir, "pids");
		const counter = join(dir, "runs");
		writeFileSync(pidsFile, "");
		const r = botDecl(crashLeavingStubbornChild(pidsFile, counter), {
			stopTimeoutMs: 300,
		});
		let firstChildAliveAtSecondStart: boolean | undefined;
		let firstStartAt = 0;
		let secondStartAt = 0;
		let starts = 0;
		r.onInfo((message) => {
			if (!/^service bot started/.test(message)) return;
			starts += 1;
			if (starts === 1) firstStartAt = Date.now();
			if (starts === 2) {
				secondStartAt = Date.now();
				const [firstChild] = readFileSync(pidsFile, "utf8").trim().split("\n");
				firstChildAliveAtSecondStart = isAlive(Number(firstChild));
			}
		});

		r.supervisor.start("bot");
		await until(() => starts >= 2, 8000);

		expect(firstChildAliveAtSecondStart).toBe(false);
		const crashAfterMs = 150;
		const slackMs = 1500;
		expect(secondStartAt - firstStartAt).toBeLessThan(
			crashAfterMs + 300 + slackMs,
		);
	}, 15_000);

	it("reports running with the pid of the group while its child outlives the lead process", async () => {
		const dir = scratchDir("dg-crash-");
		const pidsFile = join(dir, "pids");
		const counter = join(dir, "runs");
		writeFileSync(pidsFile, "");
		const r = botDecl(crashLeavingStubbornChild(pidsFile, counter), {
			stopTimeoutMs: 3000,
		});
		r.supervisor.start("bot");
		await until(() => r.status().pid !== null);
		const leadPid = r.status().pid as number;
		await until(() => readFileSync(pidsFile, "utf8").trim() !== "");
		const child = Number(readFileSync(pidsFile, "utf8").trim().split("\n")[0]);

		await until(
			() => !isAlive(leadPid) || r.status().state !== "running",
			3000,
		);

		expect(isAlive(child)).toBe(true);
		expect(r.status()).toMatchObject({ state: "running", pid: leadPid });
	}, 15_000);
});
