import {
	CHAT_PROTOCOL_VERSION,
	OVERWATCH_SESSION_ID,
	type OverwatchAction,
	type OverwatchBoard,
	type OverwatchLane,
	type OverwatchStage,
	validateChatFrame,
} from "@dg/common";
import { findDaemonPort } from "@/lib/daemon-port";

const OVERWATCH_PATH = "/overwatch";
const OVERWATCH_ACTION_PATH = "/overwatch/action";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export type OverwatchActionResult =
	| { ok: true }
	| { ok: false; error: string };

export type OverwatchApi = {
	baseUrl: string;
	getBoard(): Promise<OverwatchBoard>;
	sendAction(action: OverwatchAction): Promise<OverwatchActionResult>;
};

export type StageCell = {
	stage: Exclude<OverwatchStage, "done">;
	label: string;
	state: "done" | "now" | "pending";
};

const STAGES: StageCell["stage"][] = ["review", "ci", "e2e", "merge"];

class OverwatchHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "OverwatchHttpError";
	}
}

function parseBoard(value: unknown): OverwatchBoard {
	const frame = validateChatFrame({
		type: "overwatch-state",
		sessionId: OVERWATCH_SESSION_ID,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		board: value,
	});
	if (frame.type !== "overwatch-state") throw new Error("invalid board response");
	return frame.board;
}

export function createOverwatchApi(baseUrl: string): OverwatchApi {
	return {
		baseUrl,
		async getBoard(): Promise<OverwatchBoard> {
			const response = await fetch(`${baseUrl}${OVERWATCH_PATH}`);
			if (!response.ok) {
				const detail = (await response.text()).trim();
				throw new OverwatchHttpError(
					response.status,
					detail || `the daemon returned ${response.status}`,
				);
			}
			return parseBoard(await response.json());
		},
		async sendAction(
			action: OverwatchAction,
		): Promise<OverwatchActionResult> {
			try {
				const response = await fetch(`${baseUrl}${OVERWATCH_ACTION_PATH}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(action),
				});
				if (response.ok) return { ok: true };
				const detail = (await response.text()).trim();
				return {
					ok: false,
					error: detail || `the daemon returned ${response.status}`,
				};
			} catch {
				return { ok: false, error: "Daemon unreachable" };
			}
		},
	};
}

export async function connectOverwatchApi(
	knownPort?: number,
): Promise<OverwatchApi | undefined> {
	if (knownPort !== undefined) {
		const direct = createOverwatchApi(`http://127.0.0.1:${knownPort}`);
		try {
			await direct.getBoard();
			return direct;
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
		}
	}
	const port = await findDaemonPort();
	return port === undefined
		? undefined
		: createOverwatchApi(`http://127.0.0.1:${port}`);
}

export function overwatchPort(api: OverwatchApi): number | undefined {
	const port = Number(new URL(api.baseUrl).port);
	return Number.isFinite(port) && port > 0 ? port : undefined;
}

export function formatCountdown(
	goLive: string | undefined,
	now: Date,
): string {
	if (!goLive) return "not set";
	const target = Date.parse(goLive);
	if (Number.isNaN(target)) return "not set";
	let remaining = Math.max(0, target - now.getTime());
	const days = Math.floor(remaining / DAY_MS);
	remaining %= DAY_MS;
	const hours = Math.floor(remaining / HOUR_MS);
	remaining %= HOUR_MS;
	const minutes = Math.floor(remaining / MINUTE_MS);
	return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

export function needYouCount(lanes: OverwatchLane[]): number {
	return lanes.filter((lane) => Boolean(lane.next)).length;
}

export function stageCells(stage: OverwatchStage): StageCell[] {
	const activeIndex = stage === "done" ? STAGES.length : STAGES.indexOf(stage);
	return STAGES.map((candidate, index) => {
		if (stage === "done" || index < activeIndex) {
			return { stage: candidate, label: "complete", state: "done" };
		}
		if (index === activeIndex) {
			return { stage: candidate, label: "active", state: "now" };
		}
		return {
			stage: candidate,
			label: index === activeIndex + 1 ? "next" : "later",
			state: "pending",
		};
	});
}

export function formatUpdatedAt(updatedAt: string, now: Date): string {
	const timestamp = Date.parse(updatedAt);
	if (Number.isNaN(timestamp)) return "updated time unknown";
	const minutes = Math.max(
		0,
		Math.floor((now.getTime() - timestamp) / MINUTE_MS),
	);
	return minutes === 0 ? "updated just now" : `updated ${minutes}m ago`;
}

export function formatLaunchDate(value: string | undefined): string {
	if (!value) return "not set";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "not set";
	return new Intl.DateTimeFormat("en-US", {
		month: "numeric",
		day: "numeric",
		year: "numeric",
	}).format(date);
}
