export type Status =
	| "queued"
	| "running"
	| "blocked-user"
	| "needs-user"
	| "parked"
	| "failed"
	| "done";

export type EtaBucket =
	| "<5 min"
	| "~15 min"
	| "~30 min"
	| "~1 hr"
	| ">1 hr"
	| "unknown";

export type Owner = "agent" | "user";

export const STATUSES: readonly Status[] = [
	"queued",
	"running",
	"blocked-user",
	"needs-user",
	"parked",
	"failed",
	"done",
];

export const STATUS_EMOJI: Record<Status, string> = {
	queued: "⏳",
	running: "🔄",
	"blocked-user": "🛑",
	"needs-user": "👀",
	parked: "⏸️",
	failed: "❌",
	done: "✅",
};

export const ETA_BUCKETS: readonly EtaBucket[] = [
	"<5 min",
	"~15 min",
	"~30 min",
	"~1 hr",
	">1 hr",
	"unknown",
];

const ETA_RANK: Record<EtaBucket, number> = {
	"<5 min": 1,
	"~15 min": 2,
	"~30 min": 3,
	"~1 hr": 4,
	">1 hr": 5,
	unknown: 0,
};

export function etaRank(bucket: EtaBucket): number {
	return ETA_RANK[bucket];
}

export function isStatus(value: string): value is Status {
	return (STATUSES as readonly string[]).includes(value);
}

export function isEtaBucket(value: string): value is EtaBucket {
	return (ETA_BUCKETS as readonly string[]).includes(value);
}

/** Owner is a function of status; a done item's prior owner is not retained. */
export function ownerFor(status: Status): Owner | null {
	if (status === "blocked-user" || status === "needs-user") return "user";
	if (status === "done") return null;
	return "agent";
}

export interface ChecklistItem {
	text: string;
	status: Status;
	eta?: EtaBucket;
	children: ChecklistItem[];
}

export interface ChecklistModel {
	open: ChecklistItem[];
	done: ChecklistItem[];
}

export function emptyModel(): ChecklistModel {
	return { open: [], done: [] };
}

export function isEmptyModel(model: ChecklistModel): boolean {
	return model.open.length === 0 && model.done.length === 0;
}
