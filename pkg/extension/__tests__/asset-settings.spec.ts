/**
 * Options page asset-directory setting: daemon-authoritative over
 * config-get/config-set, deliberately NOT browser.storage.sync (Code
 * Structure's "Daemon config transport" decision — a synced filesystem path
 * is meaningless on another host). On load failure, disable the field and
 * show a daemon-not-running hint rather than a stale editable value.
 *
 * [SPEC] ASSUMED module surface — mountAssetDirectoryPanel/ConfigTransport
 * are this pass's invention, decoupled from the real WS transport via
 * injection so this suite never needs to open a socket; see deferrals.
 */
import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { mountAssetDirectoryPanel } from "../entrypoints/options/asset-directory";

function newContainer(): HTMLElement {
	const window = new Window();
	const document = window.document as unknown as Document;
	const container = document.createElement("div");
	document.body.appendChild(container);
	return container as unknown as HTMLElement;
}

function fakeTransport(
	load: { status: "ok"; value: string } | { status: "unavailable" },
	saveResult: { ok: true } | { ok: false; error: string } = { ok: true },
) {
	const getAssetDirectory = mock(() => Promise.resolve(load));
	const setAssetDirectory = mock(() => Promise.resolve(saveResult));
	return { getAssetDirectory, setAssetDirectory };
}

function input(container: HTMLElement): HTMLInputElement {
	return container.querySelector(
		"[data-asset-directory-input]",
	) as unknown as HTMLInputElement;
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("mountAssetDirectoryPanel", () => {
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
		const transport = fakeTransport(
			{ status: "ok", value: "/old/dir" },
			{ ok: true },
		);

		mountAssetDirectoryPanel(container, { transport });
		await flush();

		const field = input(container);
		field.value = "/new/dir";
		field.dispatchEvent(new Event("change"));
		await flush();

		expect(transport.setAssetDirectory).toHaveBeenCalledWith("/new/dir");
	});

	it("surfaces the daemon's rejection reason on a failed save, and leaves the field showing what the user typed", async () => {
		const container = newContainer();
		const transport = fakeTransport(
			{ status: "ok", value: "/old/dir" },
			{ ok: false, error: "not writable: EACCES" },
		);

		mountAssetDirectoryPanel(container, { transport });
		await flush();

		const field = input(container);
		field.value = "/no/permission";
		field.dispatchEvent(new Event("change"));
		await flush();

		const status = container.querySelector("[data-asset-directory-status]");
		expect(status?.textContent ?? "").toMatch(/not writable|eacces/i);
		expect(field.value).toBe("/no/permission");
	});
});

describe("createDaemonConfigTransport (lib/config.ts) — daemon config-get/config-set, never storage.sync", () => {
	it("round-trips through the injected sendConfigFrame seam without ever touching browser.storage.sync", async () => {
		const syncGet = mock(() => Promise.resolve({}));
		const syncSet = mock(() => Promise.resolve());
		mock.module("wxt/browser", () => ({
			browser: { storage: { sync: { get: syncGet, set: syncSet } } },
		}));
		const { createDaemonConfigTransport, ASSET_DIRECTORY_CONFIG_KEY } =
			await import("../lib/config");

		const sendConfigFrame = mock((frame: { type: string; key: string }) => {
			if (frame.type === "config-get") {
				return Promise.resolve({ value: "/from/daemon" });
			}
			return Promise.resolve({});
		});
		const transport = createDaemonConfigTransport({ sendConfigFrame });

		const loaded = await transport.getAssetDirectory();
		expect(loaded).toEqual({ status: "ok", value: "/from/daemon" });
		await transport.setAssetDirectory("/new/dir");

		expect(sendConfigFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "config-get",
				key: ASSET_DIRECTORY_CONFIG_KEY,
			}),
		);
		expect(sendConfigFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "config-set",
				key: ASSET_DIRECTORY_CONFIG_KEY,
				value: "/new/dir",
			}),
		);
		expect(syncGet).not.toHaveBeenCalled();
		expect(syncSet).not.toHaveBeenCalled();
	});

	it("reports load as unavailable when the daemon transport rejects, rather than throwing", async () => {
		mock.module("wxt/browser", () => ({
			browser: { storage: { sync: { get: mock(), set: mock() } } },
		}));
		const { createDaemonConfigTransport } = await import("../lib/config");
		const sendConfigFrame = mock(() => Promise.reject(new Error("no daemon")));
		const transport = createDaemonConfigTransport({ sendConfigFrame });

		const result = await transport.getAssetDirectory();
		expect(result).toEqual({ status: "unavailable" });
	});
});

describe("options/style.css — accent token aliases (slice 9 owns this file, slice 6 reads it)", () => {
	it("keeps all four OS-invariant accent aliases inside the base :root, outside the prefers-color-scheme gate", () => {
		const css = readFileSync(
			join(import.meta.dir, "../entrypoints/options/style.css"),
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

		// They restate hex values already in the file, not a new palette — light
		// aliases match the base :root's --accent/--accent2, dark aliases match
		// the values inside the dark media query.
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
