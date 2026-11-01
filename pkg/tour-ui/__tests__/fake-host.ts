import type { TourScript } from "@dg/common";
import { Window } from "happy-dom";
import type { TourHost, TourMessage } from "../src/host";

export type Mount = {
	name: string;
	root: HTMLElement;
	mountedAt: number;
	removed: boolean;
};

export type FakeHost = TourHost & {
	mounts: Mount[];
	sent: TourMessage[];
	store: Map<string, unknown>;
	emit(msg: TourMessage): void;
	live(): Mount[];
	liveText(): string;
};

const GLOBALS = ["window", "document", "Event", "location", "history"] as const;
const saved = new Map(
	GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

export function installDom(): Window {
	const win = new Window({ url: "https://app.example/start" });
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: win,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: win.document,
	});
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: win.location,
	});
	Object.defineProperty(globalThis, "history", {
		configurable: true,
		value: win.history,
	});
	Object.defineProperty(globalThis, "Event", {
		configurable: true,
		value: win.Event,
	});
	return win;
}

export function restoreDom(): void {
	for (const key of GLOBALS) {
		const descriptor = saved.get(key);
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
}

export function fakeHost(tab = "7"): FakeHost {
	const mounts: Mount[] = [];
	const sent: TourMessage[] = [];
	const store = new Map<string, unknown>();
	const handlers = new Set<(msg: TourMessage) => void>();
	const live = () => mounts.filter((m) => !m.removed);
	return {
		mounts,
		sent,
		store,
		live,
		emit: (msg) => {
			for (const handler of [...handlers]) handler(msg);
		},
		liveText: () =>
			live()
				.map((m) => m.root.textContent ?? "")
				.join("\n"),
		storage: {
			get: async <T>(key: string) => store.get(key) as T | undefined,
			set: async (key, value) => {
				store.set(key, value);
			},
			remove: async (key) => {
				store.delete(key);
			},
		},
		messages: {
			send: async (msg) => {
				sent.push(msg);
				return undefined;
			},
			on: (handler) => {
				handlers.add(handler);
				return () => {
					handlers.delete(handler);
				};
			},
		},
		mountUi: async (name, onMount) => {
			const root = document.createElement("div") as unknown as HTMLElement;
			document.body.appendChild(root);
			const mount: Mount = {
				name,
				root,
				mountedAt: performance.now(),
				removed: false,
			};
			mounts.push(mount);
			onMount(root);
			return {
				remove() {
					mount.removed = true;
					root.remove();
				},
			};
		},
		tabKey: () => tab,
	};
}

export async function until(
	predicate: () => boolean,
	what: string,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

export async function settle<T>(
	promise: Promise<T>,
	what: string,
	timeoutMs = 2000,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`timed out waiting for ${what}`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export function buttons(host: FakeHost): HTMLButtonElement[] {
	return host
		.live()
		.flatMap((m) => [
			...m.root.querySelectorAll("button"),
		]) as HTMLButtonElement[];
}

export function clickButton(host: FakeHost, label: RegExp): void {
	const found = buttons(host).find((b) => label.test(b.textContent ?? ""));
	if (!found) throw new Error(`no live button matching ${label}`);
	found.click();
}

export function clickByAria(host: FakeHost, label: string): void {
	const found = buttons(host).find(
		(b) => b.getAttribute("aria-label") === label,
	);
	if (!found) throw new Error(`no live button labeled ${label}`);
	found.click();
}

export function threeStepScript(
	overrides: Partial<TourScript> = {},
): TourScript {
	return {
		title: "Tour",
		startUrl: "https://app.example/start",
		steps: [
			{ title: "Alpha heading", body: "Alpha body text" },
			{ title: "Beta heading", body: "Beta body text" },
			{ title: "Gamma heading", body: "Gamma body text" },
		],
		...overrides,
	};
}
