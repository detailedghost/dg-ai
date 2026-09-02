import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { Window } from "happy-dom";
import { fire } from "./utils/dom-events";
import {
	bootRelay as bootSharedRelay,
	type FakeSocket,
	flushMicrotasks,
	frameEvent,
} from "./utils/relay-harness";

const syncGet = mock(() => Promise.resolve({}));
const syncSet = mock(() => Promise.resolve());
const sessionGet = mock(() => Promise.resolve({}));
let relay: ((message: unknown) => Promise<unknown>) | undefined;
mock.module("wxt/browser", () => ({
	browser: {
		storage: {
			sync: { get: syncGet, set: syncSet },
			session: { get: sessionGet },
		},
		runtime: {
			sendMessage: (message: unknown) =>
				relay
					? relay(message)
					: Promise.reject(new Error("no relay installed")),
		},
	},
}));

const { mountAssetDirectoryPanel } = await import(
	"../entrypoints/options/asset-directory"
);
const {
	ASSET_DIRECTORY_CONFIG_KEY,
	createDaemonConfigTransport,
	createLiveAssetDirectoryTransport,
	patchConfig,
} = await import("../lib/config");
const { MSG } = await import("../lib/chat-messages");

const RELAY_TEST_TIMEOUT_MS = 12_000;

const SESSION_ID = "sess-abc123";
const TOKEN = "tok-super-secret-xyz789";

function newContainer(): HTMLElement {
	const window = new Window();
	const document = window.document as unknown as Document;
	const container = document.createElement("div");
	document.body.appendChild(container);
	return container as unknown as HTMLElement;
}

function input(container: HTMLElement): HTMLInputElement {
	return container.querySelector(
		"[data-asset-directory-input]",
	) as unknown as HTMLInputElement;
}

function statusEl(container: HTMLElement): HTMLElement {
	return container.querySelector(
		"[data-asset-directory-status]",
	) as unknown as HTMLElement;
}

async function flush(): Promise<void> {
	return flushMicrotasks(4);
}

async function bootRelay(options: { confirmSession?: boolean } = {}) {
	const booted = await bootSharedRelay({
		...options,
		sessionId: SESSION_ID,
		token: TOKEN,
	});
	relay = booted.postAsOptionsPage;
	return booted;
}

function configFrames(socket: FakeSocket): Record<string, unknown>[] {
	return socket.send.mock.calls
		.map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>)
		.filter((f) => f.type === "config-get" || f.type === "config-set");
}

function answerConfig(
	socket: FakeSocket,
	fields: { key: string; value?: unknown; error?: string },
): void {
	socket.dispatch(
		"message",
		frameEvent({
			type: "config-result",
			sessionId: SESSION_ID,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			...fields,
		}),
	);
}

beforeEach(() => {
	relay = undefined;
	syncGet.mockClear();
	syncSet.mockClear();
	sessionGet.mockClear();
});

describe("createLiveAssetDirectoryTransport — the real page→background→socket relay", () => {
	it(
		"relays config-get through the background's own socket and resolves with the daemon's value",
		async () => {
			const { socket } = await bootRelay();
			const transport = createLiveAssetDirectoryTransport();

			const pending = transport.getAssetDirectory();
			await flush();

			const [frame] = configFrames(socket);
			expect(frame?.type).toBe("config-get");
			expect(frame?.key).toBe(ASSET_DIRECTORY_CONFIG_KEY);
			expect(frame?.sessionId).toBe(SESSION_ID);

			answerConfig(socket, {
				key: ASSET_DIRECTORY_CONFIG_KEY,
				value: "/home/me/.dg/assets",
			});
			expect(await pending).toEqual({
				status: "ok",
				value: "/home/me/.dg/assets",
			});
		},
		RELAY_TEST_TIMEOUT_MS,
	);

	it(
		"relays config-set with the typed value and reports success",
		async () => {
			const { socket } = await bootRelay();
			const transport = createLiveAssetDirectoryTransport();

			const pending = transport.setAssetDirectory("/new/dir");
			await flush();

			const frame = configFrames(socket).at(-1);
			expect(frame?.type).toBe("config-set");
			expect(frame?.key).toBe(ASSET_DIRECTORY_CONFIG_KEY);
			expect(frame?.value).toBe("/new/dir");

			answerConfig(socket, {
				key: ASSET_DIRECTORY_CONFIG_KEY,
				value: "/new/dir",
			});
			expect(await pending).toEqual({ ok: true });
		},
		RELAY_TEST_TIMEOUT_MS,
	);

	it(
		"never puts the session token — or anything else the daemon authenticates with — in what the options page posts",
		async () => {
			const { socket, posted } = await bootRelay();
			const transport = createLiveAssetDirectoryTransport();

			const pending = transport.setAssetDirectory("/new/dir");
			await flush();
			answerConfig(socket, {
				key: ASSET_DIRECTORY_CONFIG_KEY,
				value: "/new/dir",
			});
			await pending;

			expect(posted.length).toBe(1);
			const wire = JSON.stringify(posted);
			expect(wire).not.toContain(TOKEN);
			expect(wire).not.toContain("token");
			expect(wire).not.toContain("ws://");
			expect(configFrames(socket).at(-1)?.token).toBe(TOKEN);
		},
		RELAY_TEST_TIMEOUT_MS,
	);

	it(
		"reads no session storage and no sync storage to do it — the page holds no credential of its own",
		async () => {
			const { socket } = await bootRelay();
			const transport = createLiveAssetDirectoryTransport();

			const pending = transport.getAssetDirectory();
			await flush();
			answerConfig(socket, { key: ASSET_DIRECTORY_CONFIG_KEY, value: "/dir" });
			await pending;

			expect(sessionGet).not.toHaveBeenCalled();
			expect(syncGet).not.toHaveBeenCalled();
			expect(syncSet).not.toHaveBeenCalled();
		},
		RELAY_TEST_TIMEOUT_MS,
	);

	it(
		"surfaces the daemon's own rejection reason from a config-result error",
		async () => {
			const { socket } = await bootRelay();
			const transport = createLiveAssetDirectoryTransport();

			const pending = transport.setAssetDirectory("/no/permission");
			await flush();
			answerConfig(socket, {
				key: ASSET_DIRECTORY_CONFIG_KEY,
				error: "not writable: EACCES",
			});

			expect(await pending).toEqual({
				ok: false,
				error: "not writable: EACCES",
			});
		},
		RELAY_TEST_TIMEOUT_MS,
	);

	it(
		"matches the reply by key, so a config-result for another key never settles this request",
		async () => {
			const { socket } = await bootRelay();
			const transport = createLiveAssetDirectoryTransport();

			const pending = transport.getAssetDirectory();
			await flush();
			answerConfig(socket, { key: "someOtherKey", value: "/wrong/answer" });
			await flush();

			let settledEarly = false;
			void pending.then(() => {
				settledEarly = true;
			});
			await flush();
			expect(settledEarly).toBe(false);

			answerConfig(socket, {
				key: ASSET_DIRECTORY_CONFIG_KEY,
				value: "/right",
			});
			expect(await pending).toEqual({ status: "ok", value: "/right" });
		},
		RELAY_TEST_TIMEOUT_MS,
	);

	it(
		"reports unavailable when no chat session is open, rather than minting one to reach the daemon",
		async () => {
			await bootRelay({ confirmSession: false });
			const transport = createLiveAssetDirectoryTransport();

			expect(await transport.getAssetDirectory()).toEqual({
				status: "unavailable",
			});
		},
		RELAY_TEST_TIMEOUT_MS,
	);

	it(
		"rejects a reply carrying a foreign key — any listener in the extension can answer a runtime message first",
		async () => {
			relay = () =>
				Promise.resolve({
					key: "someOtherKey",
					value: "/someone/elses/answer",
				});

			expect(
				await createLiveAssetDirectoryTransport().getAssetDirectory(),
			).toEqual({ status: "unavailable" });
		},
		RELAY_TEST_TIMEOUT_MS,
	);

	it(
		"names an unanswered request in the save error, rather than surfacing a property-of-undefined crash",
		async () => {
			relay = () => Promise.resolve(undefined);

			expect(
				await createLiveAssetDirectoryTransport().setAssetDirectory("/new/dir"),
			).toEqual({ ok: false, error: "the background relay did not answer" });
		},
		RELAY_TEST_TIMEOUT_MS,
	);

	it(
		"refuses a config request from a content script — only this extension's own pages may write a filesystem path",
		async () => {
			const { socket, postAs } = await bootRelay();

			const answer = await postAs("https://evil.example/page.html", {
				type: MSG.configRequest,
				request: "config-set",
				key: ASSET_DIRECTORY_CONFIG_KEY,
				value: "/home/victim",
			});

			expect(answer).toBeUndefined();
			expect(configFrames(socket)).toEqual([]);
		},
		RELAY_TEST_TIMEOUT_MS,
	);

	it(
		"reports unavailable when the socket drops with the request still parked, rather than waiting out the timeout",
		async () => {
			const { socket } = await bootRelay();
			const transport = createLiveAssetDirectoryTransport();

			const pending = transport.getAssetDirectory();
			await flush();
			expect(configFrames(socket).length).toBe(1);
			socket.dispatch("close");

			expect(await pending).toEqual({ status: "unavailable" });
		},
		RELAY_TEST_TIMEOUT_MS,
	);
});

describe("lib/config.ts — no second auth path (plan.md H4)", () => {
	const code = readFileSync(
		fileURLToPath(new URL("../lib/config.ts", import.meta.url)),
		"utf8",
	)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");

	it("opens no socket of its own and reads no session token", () => {
		expect(code).not.toMatch(/storage\.session/);
		expect(code).not.toMatch(/\bWebSocket\b/);
		expect(code).not.toMatch(/openSocket/);
		expect(code).not.toMatch(/ws:\/\//);
		expect(code).not.toMatch(/\btoken\b/);
		expect(code).not.toMatch(/validateSessionBootstrap/);
	});

	it("routes the asset directory through the background relay message, not storage.sync", () => {
		expect(code).toMatch(/MSG\.configRequest/);
		const transportBody = code.slice(
			code.indexOf("export function createLiveAssetDirectoryTransport"),
		);
		expect(transportBody).not.toMatch(/storage\.sync/);
	});
});

describe("mountAssetDirectoryPanel", () => {
	function fakeTransport(
		load: { status: "ok"; value: string } | { status: "unavailable" },
		saveResult: { ok: true } | { ok: false; error: string } = { ok: true },
	) {
		return {
			getAssetDirectory: mock(() => Promise.resolve(load)),
			setAssetDirectory: mock((_v: string) => Promise.resolve(saveResult)),
		};
	}

	it("populates and enables the field from a successful daemon load", async () => {
		const container = newContainer();
		const transport = fakeTransport({
			status: "ok",
			value: "/home/me/.dg/assets",
		});

		mountAssetDirectoryPanel(container, { transport });
		await flush();

		expect(transport.getAssetDirectory).toHaveBeenCalledTimes(1);
		expect(input(container).value).toBe("/home/me/.dg/assets");
		expect(input(container).disabled).toBe(false);
	});

	it("disables the field and shows a daemon-not-running hint when the load fails", async () => {
		const container = newContainer();
		const transport = fakeTransport({ status: "unavailable" });

		mountAssetDirectoryPanel(container, { transport });
		await flush();

		expect(input(container).disabled).toBe(true);
		const hint = container.querySelector("[data-asset-directory-hint]");
		expect(hint?.textContent ?? "").toMatch(/daemon/i);
		expect(hint?.textContent ?? "").toMatch(/not running|unavailable/i);
	});

	it("saves an edited value through the injected transport on change", async () => {
		const container = newContainer();
		const transport = fakeTransport({ status: "ok", value: "/old/dir" });

		mountAssetDirectoryPanel(container, { transport });
		await flush();

		const field = input(container);
		field.value = "/new/dir";
		fire(field, "change");
		await flush();

		expect(transport.setAssetDirectory).toHaveBeenCalledWith("/new/dir");
	});

	it("renders the daemon's rejection reason as inert text, never as markup", async () => {
		const container = newContainer();
		const hostile = `not writable: <img src=x onerror="alert(1)"> & "'`;
		const transport = fakeTransport(
			{ status: "ok", value: "/old/dir" },
			{ ok: false, error: hostile },
		);

		mountAssetDirectoryPanel(container, { transport });
		await flush();

		const field = input(container);
		field.value = "/no/permission";
		fire(field, "change");
		await flush();

		const status = statusEl(container);
		expect(status.textContent).toBe(hostile);
		expect(status.querySelector("img")).toBeNull();
		expect(status.children.length).toBe(0);
		expect(status.innerHTML).toContain("&lt;img");
		expect(status.innerHTML).not.toContain("<img");
		expect(field.value).toBe("/no/permission");
	});
});

describe("createDaemonConfigTransport — the seam the live transport is built on", () => {
	it("asks for exactly the asset-directory key and reports unavailable rather than throwing", async () => {
		const sendConfigFrame = mock(() => Promise.reject(new Error("no daemon")));
		const transport = createDaemonConfigTransport({ sendConfigFrame });

		expect(await transport.getAssetDirectory()).toEqual({
			status: "unavailable",
		});
		expect(sendConfigFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "config-get",
				key: ASSET_DIRECTORY_CONFIG_KEY,
			}),
		);
	});
});

describe("options/style.css — accent token aliases the chat page reads", () => {
	it("keeps all four OS-invariant accent aliases inside the base :root, outside the prefers-color-scheme gate", () => {
		const css = readFileSync(
			fileURLToPath(
				new URL("../entrypoints/options/style.css", import.meta.url),
			),
			"utf8",
		);
		const darkGateIndex = css.indexOf("prefers-color-scheme: dark");
		expect(darkGateIndex).toBeGreaterThan(0);

		for (const alias of [
			"--accent-light",
			"--accent2-light",
			"--accent-dark",
			"--accent2-dark",
		]) {
			const declIndex = css.indexOf(`${alias}:`);
			expect(declIndex).toBeGreaterThan(0);
			expect(declIndex).toBeLessThan(darkGateIndex);
		}

		const rootBlock = css.slice(0, darkGateIndex);
		const darkBlock = css.slice(darkGateIndex);
		const hexAfter = (block: string, token: string) =>
			block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1];

		expect(hexAfter(rootBlock, "--accent-light")).toBe(
			hexAfter(rootBlock, "--accent"),
		);
		expect(hexAfter(rootBlock, "--accent2-light")).toBe(
			hexAfter(rootBlock, "--accent2"),
		);
		expect(hexAfter(rootBlock, "--accent-dark")).toBe(
			hexAfter(darkBlock, "--accent"),
		);
		expect(hexAfter(rootBlock, "--accent2-dark")).toBe(
			hexAfter(darkBlock, "--accent2"),
		);
	});
});

describe("patchConfig — fields the caller did not send", () => {
	it("writes back the stored theme, so saving another setting cannot reset it", async () => {
		syncGet.mockImplementation(() =>
			Promise.resolve({
				color: "random",
				voice: "af_heart",
				narration: "both",
				videoQuality: "1440p",
				theme: "light",
			}),
		);
		syncSet.mockClear();

		await patchConfig({ voice: "am_michael" });

		expect(syncSet).toHaveBeenCalledWith(
			expect.objectContaining({ theme: "light", voice: "am_michael" }),
		);
	});
});
