import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHAT_DEFAULT_PORT, CHAT_PORT_FALLBACK_COUNT } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	ChatStore,
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	killDaemonByPidFile,
	registerSession,
	type ChatStore as Store,
	waitForPidFile,
} from "@dg/dg-daemon/test-harness";
import {
	type CdpPageHandle,
	DEVTOOLS_URL_TIMEOUT_MS,
	DemoVerifyHarness,
} from "../src/utils/cdp-harness";

const EXTENSION_DIR = join(import.meta.dir, "..", "..", "extension");
const EXTENSION_BUILD = join(EXTENSION_DIR, ".output", "chrome-mv3");
const EXTENSION_MANIFEST = join(EXTENSION_BUILD, "manifest.json");
const MANIFEST_NAME = "dg-ai-extension";

const DAEMON_ENTRY = join(
	import.meta.dir,
	"..",
	"..",
	"dg-daemon",
	"src",
	"index.ts",
);
const AGENT_ENTRY = join(
	import.meta.dir,
	"..",
	"..",
	"dg-agent",
	"src",
	"index.ts",
);

const BROWSER_BUDGET_MS = DEVTOOLS_URL_TIMEOUT_MS + 60_000;
const FAST_TICK_MS = 150;
const PAST = "2020-01-01T00:00:00.000Z";

/**
 * The page probes the standard port range and takes the first daemon that
 * answers, so a real one already running would be read instead of this one.
 */
async function rangeIsClear(): Promise<boolean> {
	for (let i = 0; i <= CHAT_PORT_FALLBACK_COUNT; i++) {
		try {
			const res = await fetch(
				`http://127.0.0.1:${CHAT_DEFAULT_PORT + i}/health`,
				{
					headers: { Host: `127.0.0.1:${CHAT_DEFAULT_PORT + i}` },
					signal: AbortSignal.timeout(500),
				},
			);
			if (res.ok) return false;
		} catch {}
	}
	return true;
}

async function withStore<T>(
	dgHome: string,
	run: (store: Store) => T,
): Promise<T> {
	const store = await ChatStore.open(
		resolveDgPaths({ env: { DG_HOME: dgHome } }),
		FILE_ONLY_SEAMS,
	);
	try {
		return run(store);
	} finally {
		store.close();
	}
}

function daemonEnv(dgHome: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	env.DG_HOME = dgHome;
	env.DG_KEY_SOURCE = "file";
	env.DG_JOB_TICK_MS = String(FAST_TICK_MS);
	delete env.DG_PORT;
	return env;
}

async function readUntil<T>(
	read: () => Promise<T>,
	ready: (value: T) => boolean,
	label: string,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last = await read();
	while (Date.now() < deadline) {
		if (ready(last)) return last;
		await Bun.sleep(200);
		last = await read();
	}
	throw new Error(`never ${label} within ${timeoutMs}ms`);
}

const clear = await rangeIsClear();
const built = existsSync(EXTENSION_MANIFEST);

describe.skipIf(!clear || !built)(
	"the dashboard in a real browser, against a real daemon",
	() => {
		let harness: DemoVerifyHarness | undefined;
		let page: CdpPageHandle | undefined;
		let dgHome = "";
		let port = 0;
		let proc: ReturnType<typeof Bun.spawn> | undefined;

		beforeAll(async () => {
			dgHome = freshDgHome();
			await withStore(dgHome, (store) =>
				store.insertJob({
					label: "sentry-errors",
					argv: [
						"printf",
						'{"id":"SENTRY-9","title":"Checkout throws on empty cart","meta":"12 events"}\n',
					],
					cwd: process.cwd(),
					intervalMs: 15 * 60_000,
					nextRunAt: PAST,
				}),
			);

			proc = Bun.spawn([process.execPath, DAEMON_ENTRY, "__serve"], {
				env: daemonEnv(dgHome),
				stdout: "pipe",
				stderr: "pipe",
			});
			const handle = await waitForPidFile(dgHome);
			port = handle.port;

			await readUntil(
				() => withStore(dgHome, (store) => store.listFeedItems()),
				(items) => items.length > 0,
				"ran the seeded job",
			);

			harness = await DemoVerifyHarness.launch(EXTENSION_BUILD);
			const origin = await harness.confirmExtensionLoaded(MANIFEST_NAME);
			page = await harness.openPage(`${origin}/dashboard.html`);
		}, BROWSER_BUDGET_MS);

		afterAll(async () => {
			page?.dispose();
			await harness?.close();
			proc?.kill();
			killDaemonByPidFile(dgHome);
			cleanupDgHome(dgHome);
		});

		async function textOf(selector: string): Promise<string> {
			const expr = `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`;
			return String(await page?.evaluate(expr));
		}

		async function waitForText(
			selector: string,
			needle: string,
		): Promise<string> {
			return readUntil(
				() => textOf(selector),
				(found) => found.includes(needle),
				`rendered ${needle} into ${selector}`,
			);
		}

		test(
			"renders the job and the item its tick collected",
			async () => {
				expect(await waitForText(".dash__jobname", "sentry-errors")).toContain(
					"sentry-errors",
				);
				expect(
					await waitForText(".dash__itemtitle", "Checkout throws"),
				).toContain("Checkout throws on empty cart");
				expect(await textOf(".dash__meta")).toContain("12 events");
			},
			BROWSER_BUDGET_MS,
		);

		test(
			"hands an item to an agent, which then receives it on its own CLI",
			async () => {
				await waitForText(".dash__itemtitle", "Checkout throws");
				const reviewer = await registerSession(port, {
					agentIdentity: "reviewer",
				});

				const opened = await page?.evaluate(
					`(() => { const b = document.querySelector(".dash__queue"); if (!b) return false; b.click(); return true; })()`,
				);
				expect(opened).toBe(true);

				const typed = await page?.evaluate(`
				(() => {
					const input = document.querySelector(".dash__identity");
					if (!input) return false;
					input.value = "reviewer";
					input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
					return true;
				})()
			`);
				expect(typed).toBe(true);

				const recv = Bun.spawn(
					[
						process.execPath,
						AGENT_ENTRY,
						"recv",
						"--session",
						reviewer.sessionId,
						"--block",
						"--timeout",
						"10000",
					],
					{ env: daemonEnv(dgHome), stdout: "pipe", stderr: "pipe" },
				);
				const stdout = await new Response(recv.stdout).text();
				await recv.exited;

				const parsed = JSON.parse(stdout.trim()) as {
					outcome: string;
					message?: { body?: string; to?: string };
				};
				expect(parsed.outcome).toBe("delivered");
				expect(parsed.message?.to).toBe("reviewer");
				expect(String(parsed.message?.body)).toContain("Checkout throws");
			},
			BROWSER_BUDGET_MS,
		);

		test(
			"marks an item read in the daemon's own store when the page is clicked",
			async () => {
				await waitForText(".dash__itemtitle", "Checkout throws");

				const clicked = await page?.evaluate(
					`(() => { const b = document.querySelector(".dash__mark:not(:disabled)"); if (!b) return false; b.click(); return true; })()`,
				);
				expect(clicked).toBe(true);

				const items = await readUntil(
					() => withStore(dgHome, (store) => store.listFeedItems()),
					(found) => found.every((item) => item.readAt !== undefined),
					"marked the item read in the store",
				);
				expect(items).toHaveLength(1);
			},
			BROWSER_BUDGET_MS,
		);
	},
);
