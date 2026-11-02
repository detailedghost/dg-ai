import { dirname, join } from "node:path";
import { ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import {
	parsePlanMarkdown,
	type TourScript,
	toPlanMarkdown,
	validate,
} from "../utils/plan-format";
import type { PlayerJob } from "./player-job";
import type { DemoResult } from "./result";

export type BridgeEnd = { outcome: DemoResult["outcome"]; error?: string };

export type Bridge = {
	handle(msg: unknown): Promise<unknown>;
	done: Promise<BridgeEnd>;
	mode(): DemoResult["mode"];
	startedAt: string;
};

export type BridgeOptions = {
	job: Pick<PlayerJob, "dir" | "planPath" | "slug" | "video">;
	onProgress?(index: number): void | Promise<void>;
};

const CAPTIONS_ONLY = "captions-only";
const MAX_MESSAGE_CHARS = 64 * 1024;
const MAX_ERROR_CHARS = 500;
const NARRATIONS = new Set(["both", "voice", "captions"]);
const VOICE_ID = /^[a-z]{2}_[a-z]{1,32}$/;
const PRIVATE_FILE = 0o600;

export type BindingSource = {
	frame: { url(): string };
	page: { mainFrame(): unknown };
};

export function tourOrigins(script: TourScript): Set<string> {
	const origins = new Set<string>([new URL(script.startUrl).origin]);
	for (const step of [...script.steps, ...(script.setup?.steps ?? [])]) {
		if (!step.navigate) continue;
		try {
			origins.add(new URL(step.navigate, script.startUrl).origin);
		} catch {
			continue;
		}
	}
	return origins;
}

/** The binding is exposed to every frame; only the top frame of a plan origin may use it. */
export function trustedSource(
	source: BindingSource,
	origins: ReadonlySet<string>,
): boolean {
	if (source.frame !== source.page.mainFrame()) return false;
	try {
		return origins.has(new URL(source.frame.url()).origin);
	} catch {
		return false;
	}
}

const oversized = (msg: unknown): boolean => {
	try {
		return JSON.stringify(msg).length > MAX_MESSAGE_CHARS;
	} catch {
		return true;
	}
};

export function createBridge({ job, onProgress }: BridgeOptions): Bridge {
	const state = new Map<string, unknown>();
	const startedAt = new Date().toISOString();
	let mode: DemoResult["mode"] = job.video ? "video" : "walkthrough";
	let finish!: (end: BridgeEnd) => void;
	const done = new Promise<BridgeEnd>((resolve) => {
		finish = resolve;
	});

	const persist = (dir: string, name: string, text: string): string => {
		ensurePrivateDir(dir);
		const file = join(dir, name);
		writeFileAtomic(file, text, PRIVATE_FILE);
		return file;
	};

	async function handle(msg: unknown): Promise<unknown> {
		if (typeof msg !== "object" || msg === null || oversized(msg))
			return undefined;
		const m = msg as Record<string, unknown>;
		switch (m["kind"]) {
			case "storage-get":
				return state.get(String(m["key"]));
			case "storage-set":
				state.set(String(m["key"]), m["value"]);
				return undefined;
			case "storage-remove":
				state.delete(String(m["key"]));
				return undefined;
			case "choice": {
				if (m["mode"] === "video" || m["mode"] === "walkthrough")
					mode = m["mode"];
				const narration = String(m["narration"]);
				const voice = String(m["voice"]);
				persist(
					job.dir,
					"choice.json",
					JSON.stringify({
						mode,
						...(NARRATIONS.has(narration) ? { narration } : {}),
						...(VOICE_ID.test(voice) ? { voice } : {}),
						includeSetup: m["includeSetup"] === true,
					}),
				);
				return CAPTIONS_ONLY;
			}
			case "progress":
				await onProgress?.(Number(m["index"]));
				return undefined;
			case "narration-complete":
			case "clip":
				return CAPTIONS_ONLY;
			case "download-plan": {
				if (typeof m["markdown"] !== "string") return undefined;
				try {
					const script = validate(parsePlanMarkdown(m["markdown"]));
					return persist(
						dirname(job.planPath),
						`${job.slug}.edited.demo.md`,
						toPlanMarkdown(script),
					);
				} catch {
					return undefined;
				}
			}
			case "done":
				finish({ outcome: "done" });
				return undefined;
			case "stopped":
				finish({ outcome: "stopped" });
				return undefined;
			case "error":
				finish({
					outcome: "error",
					error: String(m["message"] ?? "").slice(0, MAX_ERROR_CHARS),
				});
				return undefined;
			default:
				return undefined;
		}
	}

	return { handle, done, mode: () => mode, startedAt };
}
