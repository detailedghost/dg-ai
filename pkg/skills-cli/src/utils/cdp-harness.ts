/**
 * Minimal Chrome DevTools Protocol harness for `demo --verify`: cold-starts a
 * Chromium-family browser on a dedicated throwaway profile with the built
 * dg-ai-extension side-loaded, and exposes just enough CDP (Target/Runtime/Page)
 * to drive a page and read its DOM. No user browser is ever touched — each run
 * gets its own `--user-data-dir` and an OS-assigned `--remote-debugging-port`
 * (port 0), so concurrent runs can't collide.
 *
 * Promoted from an ad-hoc debugging script (see slice 6 brief) into a committed,
 * reusable harness.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OverlayState =
	| { kind: "none" }
	| { kind: "consent" }
	| { kind: "done" }
	| { kind: "step"; index: number; total: number };

type CdpMessage = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message: string };
	sessionId?: string;
};

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Chromium-family binaries to try, in preference order. Chrome's *stable* channel
 *  disabled `--load-extension` on the CLI, so it's deliberately not a candidate here
 *  (see docs on `launch`'s `chrome-stable` handling) — Brave, Chromium, and
 *  Chrome-for-Testing builds all still honor it. */
const BROWSER_CANDIDATES = [
	"brave-browser",
	"brave",
	"chromium",
	"chromium-browser",
	"google-chrome-for-testing",
	"chrome-for-testing",
];

/** Whether to hand the browser --no-sandbox. Chrome's zygote host aborts where the
 *  kernel gives it no usable sandbox — a CI container, most notably — and then never
 *  prints the DevTools URL the harness waits for. Opt in, so a normal run keeps the
 *  sandbox it is entitled to. */
export function sandboxDisabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return !!env.DG_VERIFY_NO_SANDBOX;
}

export function browserArgs(
	profileDir: string,
	extensionDir: string,
	noSandbox: boolean,
): string[] {
	return [
		"--remote-debugging-port=0",
		`--user-data-dir=${profileDir}`,
		`--load-extension=${extensionDir}`,
		`--disable-extensions-except=${extensionDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-dev-shm-usage",
		"--headless=new",
		...(noSandbox ? ["--no-sandbox"] : []),
	];
}

export function resolveBrowserBinary(): string {
	const override = process.env.DG_VERIFY_BROWSER;
	if (override) return override;
	for (const name of BROWSER_CANDIDATES) {
		const found = Bun.which(name);
		if (found) return found;
	}
	throw new Error(
		`demo --verify needs a CDP-capable Chromium-family browser (Brave, Chromium, or Chrome-for-Testing) on PATH; ` +
			`none of [${BROWSER_CANDIDATES.join(", ")}] were found. Set DG_VERIFY_BROWSER to an explicit binary path.`,
	);
}

/**
 * A cold two-core runner has taken longer than 15s to bind the debugging port,
 * logging dbus failures the whole way, so this is sized for the slowest machine
 * that still works rather than the fastest.
 */
export const DEVTOOLS_URL_TIMEOUT_MS = 45000;

const EXIT_GRACE_MS = 2000;
const CDP_COMMAND_TIMEOUT_MS = 20000;
const CDP_CONNECT_TIMEOUT_MS = 10000;

/**
 * Signal a process and wait for it to go, escalating to SIGKILL. An unbounded wait
 * on a browser that never honours SIGTERM has no upper bound to fail against, so it
 * surfaces as whatever budget the caller happened to set.
 */
export async function killAndWait(
	proc: { kill: (signal?: number | NodeJS.Signals) => void; exited: Promise<number> },
	graceMs: number = EXIT_GRACE_MS,
): Promise<void> {
	proc.kill();
	const exited = await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), graceMs);
		void proc.exited
			.catch(() => undefined)
			.then(() => {
				clearTimeout(timer);
				resolve(true);
			});
	});
	if (exited) return;
	proc.kill("SIGKILL");
	await proc.exited.catch(() => undefined);
}

/** Scan the browser's stderr for the `DevTools listening on ws://...` line CLI prints
 *  once `--remote-debugging-port` is bound (port 0 means "OS picks one, tell me which"). */
export async function waitForDevtoolsUrl(
	stderr: ReadableStream<Uint8Array>,
	timeoutMs: number,
): Promise<string> {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const scan = (async () => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
			if (m) return m[1];
		}
		throw new Error(
			`browser exited before printing a DevTools URL:\n${buf.slice(-2000)}`,
		);
	})();
	// An uncleared timer keeps the event loop alive, so `demo --verify` used to sit
	// idle for the whole budget after already printing its findings.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`timed out waiting for a DevTools URL after ${timeoutMs}ms:\n${buf.slice(-2000)}`,
					),
				),
			timeoutMs,
		);
	}).finally(() => reader.releaseLock());
	try {
		return await Promise.race([scan, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** A thin promise-based wrapper over one CDP websocket connection. */
class CdpConnection {
	private nextId = 1;
	private readonly pending = new Map<number, (m: CdpMessage) => void>();
	private readonly eventListeners = new Set<(m: CdpMessage) => void>();

	private dead: Error | undefined;

	private constructor(private readonly ws: WebSocket) {
		const failAll = (reason: string): void => {
			this.dead ??= new Error(reason);
			for (const [id, settle] of [...this.pending]) {
				this.pending.delete(id);
				settle({ id, error: { message: reason } });
			}
		};
		ws.addEventListener("close", () =>
			failAll("the CDP connection closed before a reply arrived"),
		);
		ws.addEventListener("error", () => failAll("the CDP connection errored"));
		ws.addEventListener("message", (e) => {
			const m = JSON.parse(String(e.data)) as CdpMessage;
			if (m.id !== undefined && this.pending.has(m.id)) {
				this.pending.get(m.id)?.(m);
				this.pending.delete(m.id);
				return;
			}
			for (const listener of this.eventListeners) listener(m);
		});
	}

	/** Subscribe to every `method` event for `sessionId`; returns an unsubscribe fn. */
	on(
		method: string,
		sessionId: string,
		handler: (params: Record<string, unknown>) => void,
	): () => void {
		const listener = (m: CdpMessage): void => {
			if (m.method === method && m.sessionId === sessionId)
				handler(m.params ?? {});
		};
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	/** Resolve once `method` fires for `sessionId` (or times out — a load that never
	 *  fires shouldn't hang the whole harness). */
	waitForEvent(
		method: string,
		sessionId: string,
		timeoutMs: number,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.eventListeners.delete(onEvent);
				reject(
					new Error(`timed out waiting for ${method} after ${timeoutMs}ms`),
				);
			}, timeoutMs);
			const onEvent = (m: CdpMessage): void => {
				if (m.method === method && m.sessionId === sessionId) {
					clearTimeout(timer);
					this.eventListeners.delete(onEvent);
					resolve();
				}
			};
			this.eventListeners.add(onEvent);
		});
	}

	static async connect(url: string): Promise<CdpConnection> {
		const ws = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new Error(
							`CDP websocket never opened within ${CDP_CONNECT_TIMEOUT_MS}ms: ${url}`,
						),
					),
				CDP_CONNECT_TIMEOUT_MS,
			);
			ws.addEventListener(
				"open",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
			ws.addEventListener(
				"error",
				() => {
					clearTimeout(timer);
					reject(new Error(`CDP websocket error connecting to ${url}`));
				},
				{ once: true },
			);
		});
		return new CdpConnection(ws);
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		if (this.dead) return Promise.reject(this.dead);
		const id = this.nextId++;
		const payload: CdpMessage = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		this.ws.send(JSON.stringify(payload));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(
						`${method} got no CDP reply within ${CDP_COMMAND_TIMEOUT_MS}ms`,
					),
				);
			}, CDP_COMMAND_TIMEOUT_MS);
			this.pending.set(id, (m) => {
				clearTimeout(timer);
				if (m.error) reject(new Error(`${method} failed: ${m.error.message}`));
				else resolve(m.result ?? {});
			});
		});
	}

	close(): void {
		this.ws.close();
	}
}

async function evaluate(
	conn: CdpConnection,
	sessionId: string,
	expression: string,
): Promise<unknown> {
	const result = await conn.send(
		"Runtime.evaluate",
		{ expression, awaitPromise: true, returnByValue: true },
		sessionId,
	);
	const exceptionDetails = result.exceptionDetails as
		| { text?: string; exception?: { description?: string } }
		| undefined;
	if (exceptionDetails) {
		throw new Error(
			`page evaluate threw: ${exceptionDetails.exception?.description ?? exceptionDetails.text ?? "unknown error"}`,
		);
	}
	return (result.result as { value?: unknown } | undefined)?.value;
}

/** One attached page target: the mechanics `demo-verify` drives the tour through. */
export class CdpPageHandle {
	/** Main-frame URLs navigated to since the last `drainNavigations()` call. A tour's
	 *  own corrective re-navigation ("bounce") can round-trip fast enough that two
	 *  `locationHref()` reads spaced hundreds of ms apart both land back on the
	 *  original URL and never observe it — this listener can't miss it either way. */
	private readonly navigations: string[] = [];
	private readonly unsubscribeNav: () => void;

	constructor(
		private readonly conn: CdpConnection,
		private readonly sessionId: string,
	) {
		this.unsubscribeNav = conn.on(
			"Page.frameNavigated",
			sessionId,
			(params) => {
				const frame = params.frame as
					| { url?: string; parentId?: string }
					| undefined;
				if (frame?.url && !frame.parentId) this.navigations.push(frame.url);
			},
		);
	}

	/** Every main-frame URL navigated to since the last drain, then clears the log. */
	drainNavigations(): string[] {
		return this.navigations.splice(0, this.navigations.length);
	}

	dispose(): void {
		this.unsubscribeNav();
	}

	evaluate(expression: string): Promise<unknown> {
		return evaluate(this.conn, this.sessionId, expression);
	}

	async locationHref(): Promise<string> {
		return String(await this.evaluate("location.href"));
	}

	/** Mirrors safeQuerySelector's contract: invalid CSS resolves to "not found", not a throw. */
	async selectorResolves(selector: string): Promise<boolean> {
		const expr = `(() => { try { return document.querySelector(${JSON.stringify(selector)}) !== null; } catch { return false; } })()`;
		return Boolean(await this.evaluate(expr));
	}

	/**
	 * Read the tour's own rendered overlay rather than re-deriving its state: any
	 * shadow host tagged `dg-*` (the extension's UI-isolation convention) is inspected
	 * for the "approve automatic actions" consent card, a "Step N of M" progress line,
	 * or the "Walkthrough complete" end card.
	 */
	async readTourOverlay(): Promise<OverlayState> {
		const expr = `
			(() => {
				const hosts = [...document.querySelectorAll("*")].filter((e) => e.shadowRoot && e.tagName.startsWith("DG"));
				for (const host of hosts) {
					const root = host.shadowRoot;
					const buttons = [...root.querySelectorAll("button")];
					if (buttons.some((b) => (b.textContent || "").trim() === "Approve automatic actions")) {
						return JSON.stringify({ kind: "consent" });
					}
					const texts = [...root.querySelectorAll("div")].map((d) => d.textContent || "");
					const progress = texts.find((t) => /Step \\d+ of \\d+/.test(t));
					if (progress) {
						const m = progress.match(/Step (\\d+) of (\\d+)/);
						return JSON.stringify({ kind: "step", index: Number(m[1]) - 1, total: Number(m[2]) });
					}
					if (texts.some((t) => t.includes("Walkthrough complete"))) {
						return JSON.stringify({ kind: "done" });
					}
				}
				return JSON.stringify({ kind: "none" });
			})()
		`;
		return JSON.parse(String(await this.evaluate(expr))) as OverlayState;
	}

	/** Click whichever control the current overlay offers, by accessible name, the
	 *  same way a real user would — including skipping a disabled "Next step" so
	 *  the last step falls through to "Done" instead of a no-op click. */
	async clickThroughTour(): Promise<boolean> {
		const expr = `
			(() => {
				const hosts = [...document.querySelectorAll("*")].filter((e) => e.shadowRoot && e.tagName.startsWith("DG"));
				for (const host of hosts) {
					const root = host.shadowRoot;
					const buttons = [...root.querySelectorAll("button")];
					const approve = buttons.find((b) => (b.textContent || "").trim() === "Approve automatic actions");
					if (approve) { approve.click(); return true; }
					const next = root.querySelector('[aria-label="Next step"]:not(:disabled), [title="Next step"]:not(:disabled)');
					if (next) { next.click(); return true; }
					const done = buttons.find((b) => (b.textContent || "").trim() === "Done");
					if (done) { done.click(); return true; }
				}
				return false;
			})()
		`;
		return Boolean(await this.evaluate(expr));
	}
}

/** `URL.origin` is "null" for a non-special scheme, so read it off the string. */
function extensionOriginOf(url: string): string {
	const match = /^(chrome-extension:\/\/[^/]+)/.exec(url);
	if (!match) throw new Error(`not an extension URL: ${url}`);
	return match[1];
}

/** A cold-started, extension-loaded, throwaway-profile browser for one verify run. */
export class DemoVerifyHarness {
	private constructor(
		private readonly proc: ReturnType<typeof Bun.spawn>,
		private readonly conn: CdpConnection,
		private readonly profileDir: string,
	) {}

	static async launch(extensionDir: string): Promise<DemoVerifyHarness> {
		const bin = resolveBrowserBinary();
		const profileDir = mkdtempSync(join(tmpdir(), "dg-verify-profile-"));
		// Bun.spawn (a bad binary throws ENOENT synchronously) is inside this try too,
		// so profileDir is never orphaned regardless of where launch fails.
		try {
			const proc = Bun.spawn(
				[
					bin,
					...browserArgs(profileDir, extensionDir, sandboxDisabled()),
					"about:blank",
				],
				{ stdout: "ignore", stderr: "pipe" },
			);
			try {
				const wsUrl = await waitForDevtoolsUrl(
					proc.stderr,
					DEVTOOLS_URL_TIMEOUT_MS,
				);
				const conn = await CdpConnection.connect(wsUrl);
				return new DemoVerifyHarness(proc, conn, profileDir);
			} catch (err) {
				proc.kill();
				throw err;
			}
		} catch (err) {
			rmSync(profileDir, { recursive: true, force: true });
			throw err;
		}
	}

	async close(): Promise<void> {
		this.conn.close();
		await killAndWait(this.proc);
		rmSync(this.profileDir, { recursive: true, force: true });
	}

	/**
	 * Fail fast with a clear reason instead of a mystery timeout when the extension
	 * didn't load. Every Chromium ships component extensions with their own service
	 * workers (Hangout Services, the TTS engine) — taking the first `service_worker`
	 * target would pick one of those up and look exactly like `--load-extension`
	 * being ignored, so match by manifest name instead of enumeration order.
	 */
	async confirmExtensionLoaded(
		manifestName: string,
		timeoutMs = 10000,
	): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		const seen: string[] = [];
		while (Date.now() < deadline) {
			const { targetInfos } = (await this.conn.send("Target.getTargets")) as {
				targetInfos: Array<{ targetId: string; type: string; url: string }>;
			};
			for (const t of targetInfos.filter((x) => x.type === "service_worker")) {
				const { sessionId } = (await this.conn.send("Target.attachToTarget", {
					targetId: t.targetId,
					flatten: true,
				})) as { sessionId: string };
				let name: unknown;
				try {
					name = await evaluate(
						this.conn,
						sessionId,
						"chrome.runtime.getManifest().name",
					);
				} catch {
					name = undefined;
				}
				seen.push(`${String(name)} @ ${t.url}`);
				const matched = name === manifestName;
				await this.conn.send("Target.detachFromTarget", { sessionId });
				if (matched) return extensionOriginOf(t.url);
			}
			await wait(250);
		}
		throw new Error(
			`extension "${manifestName}" never registered a matching service worker within ${timeoutMs}ms ` +
				`(--load-extension may have been ignored). saw: ${seen.join("; ") || "no service workers at all"}`,
		);
	}

	/**
	 * Open `url` in a fresh tab and hand back a page handle.
	 *
	 * Creating the target *with* the marked URL (rather than starting blank and
	 * issuing `Page.navigate` ourselves) matters: on a just-cold-started extension,
	 * a `Page.navigate`-driven first load can commit before the extension's content
	 * scripts finish registering, so `demo-tour.content.ts` silently never runs on
	 * it. A follow-up `Page.reload` always produced the tour overlay in manual
	 * testing (see slice 6 notes) — so every open reloads once before returning.
	 */
	async openPage(url: string): Promise<CdpPageHandle> {
		const { targetId } = (await this.conn.send("Target.createTarget", {
			url,
		})) as {
			targetId: string;
		};
		const { sessionId } = (await this.conn.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		})) as { sessionId: string };
		await this.conn.send("Page.enable", {}, sessionId);
		await this.conn.send("Runtime.enable", {}, sessionId);

		// Page wasn't enabled when the initial navigation may have started, so its
		// loadEventFired can't be awaited reliably — just give it a moment to settle.
		await wait(1000);
		await this.conn.send("Page.reload", {}, sessionId);
		await this.conn.waitForEvent("Page.loadEventFired", sessionId, 15000);

		return new CdpPageHandle(this.conn, sessionId);
	}
}
