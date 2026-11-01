import { afterEach, describe, expect, it, mock } from "bun:test";

const sendMessage = mock(() => Promise.resolve(undefined));
const addListener = mock((_fn: unknown) => {});
const removeListener = mock((_fn: unknown) => {});
const local = {
	get: mock((_keys: unknown) => Promise.resolve({} as Record<string, unknown>)),
	set: mock((_items: unknown) => Promise.resolve()),
	remove: mock((_keys: unknown) => Promise.resolve()),
};

mock.module("wxt/browser", () => ({
	browser: {
		runtime: { sendMessage, onMessage: { addListener, removeListener } },
		storage: { local, sync: { get: mock(() => Promise.resolve({})) } },
	},
}));

import { tourKeys } from "@dg/tour-ui";
import { MSG } from "@/lib/demo-messages";
import { wxtHost } from "@/lib/tour-host";

type UiOptions = {
	name: string;
	onMount: (container: HTMLElement) => void;
};

const originalUi = Object.getOwnPropertyDescriptor(
	globalThis,
	"createShadowRootUi",
);

afterEach(() => {
	for (const fn of [sendMessage, addListener, removeListener]) fn.mockClear();
	for (const fn of Object.values(local)) fn.mockClear();
	local.get.mockImplementation(() => Promise.resolve({}));
	if (originalUi)
		Object.defineProperty(globalThis, "createShadowRootUi", originalUi);
	else Reflect.deleteProperty(globalThis, "createShadowRootUi");
});

const ctx = { id: "ctx" } as unknown as Parameters<typeof wxtHost>[0];

describe("wxtHost tab key", () => {
	it("asks the background once and keys the tour by that tab", async () => {
		sendMessage.mockImplementationOnce(() =>
			Promise.resolve({ tabId: 12 } as unknown as undefined),
		);

		const host = await wxtHost(ctx);

		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledWith({ type: MSG.whoami });
		expect(host.tabKey()).toBe("12");
	});

	it("uses a tab id the caller already knows without asking", async () => {
		const host = await wxtHost(ctx, 3);

		expect(host.tabKey()).toBe("3");
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("rejects when the background reports no tab id", async () => {
		await expect(wxtHost(ctx)).rejects.toThrow("tab id");
	});
});

describe("wxtHost storage", () => {
	it("derives the four storage keys the extension already uses", async () => {
		expect(tourKeys(await wxtHost(ctx, 5))).toEqual({
			state: "demo_tour:5",
			recording: "demo_recording:5",
			edit: "demo_edit:5",
			pending: "demo_pending:5",
		});
	});

	it("reads a value from browser.storage.local under the exact key", async () => {
		local.get.mockImplementation((keys) =>
			Promise.resolve({ [keys as string]: { index: 2 } }),
		);

		const value = await (await wxtHost(ctx, 5)).storage.get<{ index: number }>(
			"demo_tour:5",
		);

		expect(value).toEqual({ index: 2 });
		expect(local.get).toHaveBeenCalledWith("demo_tour:5");
	});

	it("returns undefined for a missing key", async () => {
		expect(
			await (await wxtHost(ctx, 5)).storage.get("demo_pending:5"),
		).toBeUndefined();
	});

	it("writes and removes under the exact key", async () => {
		const host = await wxtHost(ctx, 5);

		await host.storage.set("demo_recording:5", true);
		await host.storage.remove("demo_edit:5");

		expect(local.set).toHaveBeenCalledWith({ "demo_recording:5": true });
		expect(local.remove).toHaveBeenCalledWith("demo_edit:5");
	});
});

describe("wxtHost messages", () => {
	it("sends progress as the extension's play-step message", async () => {
		await (await wxtHost(ctx, 5)).messages.send({ kind: "progress", index: 1 });

		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledWith({
			type: MSG.playStep,
			index: 1,
		});
	});

	it("sends done and stopped as the extension's video-stop message", async () => {
		const host = await wxtHost(ctx, 5);

		await host.messages.send({ kind: "done" });
		await host.messages.send({ kind: "stopped" });

		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(sendMessage).toHaveBeenNthCalledWith(1, { type: MSG.videoStop });
		expect(sendMessage).toHaveBeenNthCalledWith(2, { type: MSG.videoStop });
	});

	it("does not put kind-tagged payloads on the extension wire", async () => {
		const host = await wxtHost(ctx, 5);

		await host.messages.send({ kind: "error", message: "boom" });
		await host.messages.send({ kind: "download-plan", markdown: "# plan" });

		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("turns the extension's narration-complete message into a tour message", async () => {
		const received: unknown[] = [];
		(await wxtHost(ctx, 5)).messages.on((msg) => received.push(msg));
		const listener = addListener.mock.calls[0]?.[0] as (raw: unknown) => void;

		listener({ type: MSG.narrationComplete, index: 2 });
		listener({ type: MSG.videoSaved });

		expect(received).toEqual([{ kind: "narration-complete", index: 2 }]);
	});

	it("carries a clip length through when the wire message has one", async () => {
		const received: unknown[] = [];
		(await wxtHost(ctx, 5)).messages.on((msg) => received.push(msg));
		const listener = addListener.mock.calls[0]?.[0] as (raw: unknown) => void;

		listener({ type: MSG.narrationComplete, index: 1, ms: 2400 });

		expect(received).toEqual([
			{ kind: "narration-complete", index: 1, ms: 2400 },
		]);
	});

	it("sends nothing for kinds the extension wire has no message for", async () => {
		const host = await wxtHost(ctx, 5);

		await host.messages.send({
			kind: "choice",
			mode: "video",
			narration: "both",
			voice: "af_heart",
			includeSetup: false,
		});
		await host.messages.send({
			kind: "clip",
			index: 0,
			sampleRate: 24000,
			pcm: "",
		});

		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("registers a runtime listener and removes the same one on dispose", async () => {
		const off = (await wxtHost(ctx, 5)).messages.on(() => {});

		expect(addListener).toHaveBeenCalledTimes(1);
		const registered = addListener.mock.calls[0]?.[0];
		off();

		expect(removeListener).toHaveBeenCalledWith(registered);
	});
});

describe("wxtHost mountUi", () => {
	it("mounts a shadow-root overlay for the context and hands back the root", async () => {
		let options: UiOptions | undefined;
		let removed = 0;
		let mountedCtx: unknown;
		Object.defineProperty(globalThis, "createShadowRootUi", {
			configurable: true,
			value: async (c: unknown, opts: UiOptions) => {
				mountedCtx = c;
				options = opts;
				return { mount() {}, remove: () => removed++ };
			},
		});
		const container = { tag: "container" } as unknown as HTMLElement;
		let received: HTMLElement | undefined;

		const handle = await (await wxtHost(ctx, 5)).mountUi(
			"dg-demo-tour",
			(root) => {
				received = root;
			},
		);
		options?.onMount(container);
		handle.remove();

		expect(mountedCtx).toBe(ctx);
		expect(options?.name).toBe("dg-demo-tour");
		expect(received).toBe(container);
		expect(removed).toBe(1);
	});
});
