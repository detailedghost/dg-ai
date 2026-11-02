import { NARRATION_ASSET_BASE, type TourScript } from "@dg/common";
import type { TourHost, TourMessage } from "../host";
import { createNarrator } from "../narration/narrate";
import { runTour, type TourOptions, type TourResult } from "../player";

export type TourState =
	| { kind: "none" }
	| { kind: "step"; index: number; total: number }
	| { kind: "done" }
	| { kind: "ended"; outcome: "stopped" | "error"; error?: string };

declare global {
	interface Window {
		__dgDemoBridge?: (msg: unknown) => Promise<unknown>;
		__dgTour: {
			run(script: TourScript, opts?: TourOptions): Promise<TourResult>;
			state(): TourState;
			advance(): boolean;
		};
	}
}

const memory = new Map<string, unknown>();

const captured = window.__dgDemoBridge;
if (captured) delete window.__dgDemoBridge;

const bridge = (msg: unknown): Promise<unknown> => {
	const call = captured ?? window.__dgDemoBridge;
	return call ? call(msg) : Promise.resolve(undefined);
};

let state: TourState = { kind: "none" };
let advance: (() => void) | undefined;

const host: TourHost = {
	storage: {
		async get<T>(key: string) {
			if (!captured && !window.__dgDemoBridge)
				return memory.get(key) as T | undefined;
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
	narrator: createNarrator(NARRATION_ASSET_BASE, bridge),
};

const tour: Window["__dgTour"] = {
	async run(script, opts) {
		const result = await runTour(host, script, {
			...opts,
			onStep: (index, next) => {
				state = { kind: "step", index, total: script.steps.length };
				advance = next;
				opts?.onStep?.(index, next);
			},
		});
		state =
			result.outcome === "done"
				? { kind: "done" }
				: {
						kind: "ended",
						outcome: result.outcome,
						...(result.error ? { error: result.error } : {}),
					};
		await host.messages.send(
			result.outcome === "done"
				? { kind: "done" }
				: result.outcome === "stopped"
					? { kind: "stopped" }
					: { kind: "error", message: result.error ?? "" },
		);
		return result;
	},
	state: () => state,
	advance: () => {
		if (!advance) return false;
		advance();
		return true;
	},
};

Object.defineProperty(window, "__dgTour", {
	value: tour,
	writable: false,
	configurable: false,
});
