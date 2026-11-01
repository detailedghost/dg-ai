import type { TourScript } from "@dg/common";
import type { TourHost, TourMessage } from "../host";
import { runTour, type TourOptions, type TourResult } from "../player";

declare global {
	interface Window {
		__dgDemoBridge?: (msg: unknown) => Promise<unknown>;
		__dgTour: {
			run(script: TourScript, opts?: TourOptions): Promise<TourResult>;
		};
	}
}

const memory = new Map<string, unknown>();

const bridge = (msg: unknown): Promise<unknown> =>
	window.__dgDemoBridge
		? window.__dgDemoBridge(msg)
		: Promise.resolve(undefined);

const host: TourHost = {
	storage: {
		async get<T>(key: string) {
			if (!window.__dgDemoBridge) return memory.get(key) as T | undefined;
			return (await bridge({ kind: "storage-get", key })) as T | undefined;
		},
		async set(key, value) {
			memory.set(key, value);
			await bridge({ kind: "storage-set", key, value });
		},
		async remove(key) {
			memory.delete(key);
			await bridge({ kind: "storage-remove", key });
		},
	},
	messages: {
		send: (msg: TourMessage) => bridge(msg),
		on: () => () => undefined,
	},
	async mountUi(name, onMount) {
		const el = document.createElement("div");
		el.id = `dg-${name}`;
		const root = el.attachShadow({ mode: "open" });
		const container = document.createElement("div");
		root.appendChild(container);
		document.documentElement.appendChild(el);
		onMount(container);
		return { remove: () => el.remove() };
	},
	tabKey: () => "local",
};

window.__dgTour = {
	async run(script, opts) {
		const result = await runTour(host, script, opts);
		await host.messages.send(
			result.outcome === "done"
				? { kind: "done" }
				: result.outcome === "stopped"
					? { kind: "stopped" }
					: { kind: "error", message: result.error ?? "" },
		);
		return result;
	},
};
