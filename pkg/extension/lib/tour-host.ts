import type { TourHost, TourMessage } from "@dg/tour-ui";
import { browser } from "wxt/browser";
import { MSG } from "@/lib/demo-messages";

type Ctx = InstanceType<typeof ContentScriptContext>;

function toWire(msg: TourMessage): { type: string; index?: number } | null {
	switch (msg.kind) {
		case "progress":
			return { type: MSG.playStep, index: msg.index };
		case "done":
		case "stopped":
			return { type: MSG.videoStop };
		default:
			return null;
	}
}

function fromWire(raw: unknown): TourMessage | null {
	const msg = raw as { type?: string; index?: unknown; ms?: unknown } | null;
	if (msg?.type !== MSG.narrationComplete) return null;
	return {
		kind: "narration-complete",
		...(typeof msg.index === "number" ? { index: msg.index } : {}),
		...(typeof msg.ms === "number" ? { ms: msg.ms } : {}),
	};
}

async function askTabId(): Promise<number> {
	const res = (await browser.runtime.sendMessage({ type: MSG.whoami })) as
		| { tabId?: number | null }
		| undefined;
	if (typeof res?.tabId !== "number")
		throw new Error("No tab id: the background did not report one.");
	return res.tabId;
}

/** The tour host for a content script; pass `tabId` when the caller already knows it. */
export async function wxtHost(ctx: Ctx, tabId?: number): Promise<TourHost> {
	const tab = String(tabId ?? (await askTabId()));
	return {
		storage: {
			async get<T>(key: string) {
				const got = await browser.storage.local.get(key);
				return got[key] as T | undefined;
			},
			set: (key, value) => browser.storage.local.set({ [key]: value }),
			remove: (key) => browser.storage.local.remove(key),
		},
		messages: {
			async send(msg: TourMessage) {
				const wire = toWire(msg);
				return wire ? browser.runtime.sendMessage(wire) : undefined;
			},
			on(handler) {
				const listener = (raw: unknown): void => {
					const msg = fromWire(raw);
					if (msg) handler(msg);
				};
				browser.runtime.onMessage.addListener(listener);
				return () => browser.runtime.onMessage.removeListener(listener);
			},
		},
		async mountUi(name, onMount) {
			const ui = await createShadowRootUi(ctx, {
				name,
				position: "overlay",
				anchor: "html",
				zIndex: 2147483647,
				onMount,
			});
			ui.mount();
			return { remove: () => ui.remove() };
		},
		tabKey: () => tab,
	};
}
