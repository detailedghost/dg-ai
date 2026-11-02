import { dirname, join } from "node:path";
import { ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import {
	parsePlanMarkdown,
	type TourScript,
	toPlanMarkdown,
	validate,
} from "../utils/plan-format";
import { clipFile, NARRATION_SAMPLE_RATE } from "./narration";
import type { PlayerJob } from "./player-job";
import type { DemoResult } from "./result";

export type BridgeEnd = { outcome: DemoResult["outcome"]; error?: string };

export type Bridge = {
	handle(msg: unknown): Promise<unknown>;
	done: Promise<BridgeEnd>;
	mode(): DemoResult["mode"];
	startedAt: string;
};

export type NarrationAnswer = "voice" | "captions-only";

export type BridgeOptions = {
	job: Pick<PlayerJob, "dir" | "planPath" | "slug" | "video">;
	onProgress?(index: number): void | Promise<void>;
	/** Called for a video choice that wants a voice; answers whether the page may narrate. */
	onVoiceChoice?(): Promise<NarrationAnswer>;
	onNarrationFailed?(reason: string): void;
	/** Called with the key of a storage-set the bridge refused for size. */
	onOversized?(key: string): void;
	steps?: number;
};

const CAPTIONS_ONLY = "captions-only";
const MAX_MESSAGE_CHARS = 1024 * 1024;
const MAX_CLIP_BYTES = 8 * 1024 * 1024;
const MAX_CLIP_INDEX = 999;
const MAX_TOTAL_CLIP_BYTES = 192 * 1024 * 1024;
const MAX_REASON_CHARS = 200;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
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

const CLIP_LIMIT = Math.ceil((MAX_CLIP_BYTES * 4) / 3);

const oversized = (msg: object): boolean => {
	const m = msg as Record<string, unknown>;
	if (m["kind"] === "clip")
		return typeof m["pcm"] === "string" && m["pcm"].length > CLIP_LIMIT;
	try {
		return JSON.stringify(msg).length > MAX_MESSAGE_CHARS;
	} catch {
		return true;
	}
};

export function createBridge({
	job,
	onProgress,
	onVoiceChoice,
	onNarrationFailed,
	onOversized,
	steps = MAX_CLIP_INDEX + 1,
}: BridgeOptions): Bridge {
	let voiceGranted = false;
	let clipBytes = 0;
	const validIndex = (index: unknown): index is number =>
		typeof index === "number" &&
		Number.isInteger(index) &&
		index >= 0 &&
		index < Math.min(steps, MAX_CLIP_INDEX + 1);
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

	function saveClip(m: Record<string, unknown>): void {
		const index = m["index"];
		const pcm = m["pcm"];
		if (
			!voiceGranted ||
			!validIndex(index) ||
			m["sampleRate"] !== NARRATION_SAMPLE_RATE ||
			typeof pcm !== "string" ||
			!BASE64.test(pcm)
		)
			return;
		const bytes = Buffer.from(pcm, "base64");
		if (
			bytes.length === 0 ||
			bytes.length > MAX_CLIP_BYTES ||
			bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0
		)
			return;
		if (clipBytes + bytes.length > MAX_TOTAL_CLIP_BYTES) return;
		clipBytes += bytes.length;
		const dir = join(job.dir, "clips");
		ensurePrivateDir(dir);
		writeFileAtomic(clipFile(dir, index), bytes, PRIVATE_FILE);
	}

	async function handle(msg: unknown): Promise<unknown> {
		if (typeof msg !== "object" || msg === null) return undefined;
		const m = msg as Record<string, unknown>;
		if (oversized(msg)) {
			if (m["kind"] !== "storage-set") return undefined;
			onOversized?.(String(m["key"]));
			return { error: "storage value is over the 1 MiB limit" };
		}
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
				const voiced = narration === "both" || narration === "voice";
				if (mode !== "video" || !voiced || !onVoiceChoice) return CAPTIONS_ONLY;
				const answer = await onVoiceChoice();
				voiceGranted = answer === "voice";
				return answer;
			}
			case "progress":
				{
					const index = Number(m["index"]);
					if (validIndex(index)) await onProgress?.(index);
				}
				return undefined;
			case "narration-failed":
				if (voiceGranted)
					onNarrationFailed?.(
						String(m["reason"] ?? "")
							.replace(/[^\x20-\x7e]/g, " ")
							.slice(0, MAX_REASON_CHARS),
					);
				return undefined;
			case "narration-complete":
				return CAPTIONS_ONLY;
			case "clip":
				saveClip(m);
				return undefined;
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
