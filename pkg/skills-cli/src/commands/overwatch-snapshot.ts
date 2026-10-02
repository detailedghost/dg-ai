import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	OVERWATCH_SESSION_ID,
	type OverwatchBoard,
	type OverwatchLane,
	type OverwatchStage,
	validateChatFrame,
} from "@dg/common";
import type { Command } from "commander";

const SNAPSHOT_DIRECTORY = "/tmp/ai/dg-overwatch";
const THROTTLE_WINDOW_MS = 120_000;
const STAGES = ["review", "ci", "e2e", "merge"] as const;
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

type SnapshotOptions = {
	now?: Date;
	outPath?: string;
	scratchRoot?: string;
	throttleKey?: string;
};

export type SnapshotWriteResult =
	| { status: "written"; path: string }
	| { status: "throttled"; seconds: number };

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character] ?? character,
	);
}

function escapeText(value: string): string {
	return escapeHtml(value.replace(/[—–─]/g, "-"));
}

function parseDate(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : undefined;
}

function clockTime(date: Date): string {
	const hour = date.getUTCHours();
	const displayHour = hour % 12 || 12;
	const minute = String(date.getUTCMinutes()).padStart(2, "0");
	return `${displayHour}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}

function dateTime(date: Date): string {
	return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${clockTime(date)} UTC`;
}

function launchDate(label: string, value: string | undefined): string {
	const date = parseDate(value);
	return date ? `${label} ${dateTime(date)}` : `${label} NOT SET`;
}

function countdown(goLive: string | undefined, now: Date): string {
	const target = parseDate(goLive);
	if (!target) return "GO LIVE NOT SET";
	const remaining = target.getTime() - now.getTime();
	if (remaining <= 0) return "GO LIVE TIME REACHED";
	const days = Math.floor(remaining / 86_400_000);
	const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
	return `${days}D ${hours}H TO GO LIVE`;
}

function stageState(
	current: OverwatchStage,
	stage: (typeof STAGES)[number],
): "done" | "now" | "pending" {
	if (current === "done") return "done";
	const currentIndex = STAGES.indexOf(current);
	const stageIndex = STAGES.indexOf(stage);
	if (stageIndex < currentIndex) return "done";
	return stageIndex === currentIndex ? "now" : "pending";
}

function stageCells(lane: OverwatchLane): string {
	return STAGES.map((stage) => {
		const state = stageState(lane.stage, stage);
		return `<div class="cell ${state}" data-stage="${stage}" data-state="${state}"><span>${stage.toUpperCase()}</span><strong>${state}</strong></div>`;
	}).join("");
}

function chatTile(lane: OverwatchLane): string {
	const stats = [
		`<span>MR ${escapeText(lane.mr ?? "NONE")}</span>`,
		`<span>ETA ${escapeText(lane.eta ?? "UNKNOWN")}</span>`,
		lane.next
			? `<strong class="next">NEXT: ${escapeText(lane.next)}</strong>`
			: "",
	].join("");
	const link = lane.url
		? `<a class="open" href="${escapeHtml(lane.url)}" target="_blank" rel="noopener noreferrer">Open chat</a>`
		: '<span class="nolink">No link</span>';
	return `<article class="lane${lane.next ? " wait" : ""}" data-chat-tile><div class="who"><strong>${escapeText(lane.chat)}</strong><small>${escapeText(lane.task)}</small></div>${stageCells(lane)}<div class="detail"><div class="stats">${stats}</div>${link}</div></article>`;
}

function backgroundLane(lane: OverwatchLane): string {
	const details = [lane.task, lane.eta ? `ETA ${lane.eta}` : "", lane.next ? `NEXT: ${lane.next}` : ""]
		.filter(Boolean)
		.map((value) => `<span>${escapeText(value)}</span>`)
		.join("");
	return `<p><strong>${escapeText(lane.chat)}</strong>${details}</p>`;
}

function mergeItem(merge: OverwatchBoard["merges"][number]): string {
	return `<span>${escapeText(merge.mr)} ${escapeText(merge.title)}</span>`;
}

export function renderOverwatchSnapshot(
	board: OverwatchBoard,
	now = new Date(),
): string {
	const chats = board.lanes.filter((lane) => lane.kind === "chat");
	const background = board.lanes.filter((lane) => lane.kind === "background");
	const needYou = board.lanes.filter((lane) => Boolean(lane.next)).length;
	const tiles = chats.length
		? chats.map(chatTile).join("")
		: '<div class="empty">No active chats</div>';
	const backgroundItems = background.length
		? background.map(backgroundLane).join("")
		: "<p>None active</p>";
	const merges = board.merges.length
		? board.merges.map(mergeItem).join("")
		: "<span>None today</span>";
	const dates = `${launchDate("GO OR NO GO", board.goNoGo)} | ${launchDate("GO LIVE", board.goLive)}`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Overwatch snapshot</title>
<style>
:root{--ink:#171717;--paper:#f7f6f1;--panel:#fff;--cyan:#0891b2;--mag:#c026d3;--soft:#dedbd1;color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.board{min-height:100vh;padding:24px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;border:2px solid var(--ink);background:var(--panel);padding:13px 15px;box-shadow:5px 5px 0 var(--ink)}.top strong{font-size:clamp(16px,2.4vw,24px)}.need{background:var(--mag);color:#fff;padding:9px 12px;border:2px solid var(--ink);font-weight:900;white-space:nowrap}.dates,.asof{margin-top:14px;font-size:12px;font-weight:900;text-align:right}.asof{margin-top:6px;color:#555}.axis,.lane{display:grid;grid-template-columns:170px repeat(4,minmax(0,1fr));gap:8px}.axis{margin:32px 0 10px}.axis span{font-size:11px;text-transform:uppercase;font-weight:900;text-align:center;padding:8px}.axis span:not(:first-child){border-bottom:4px solid var(--ink)}.lane{align-items:stretch;margin-bottom:16px}.who{border:3px solid var(--ink);background:var(--panel);padding:14px}.who strong{display:block;font-size:17px;overflow-wrap:anywhere}.who small{display:block;line-height:1.4;margin-top:5px}.cell{min-height:74px;border:2px solid var(--soft);background:var(--panel);display:flex;flex-direction:column;gap:5px;align-items:center;justify-content:center;padding:8px;text-align:center;font-size:11px}.cell span{display:none}.cell.done{border-color:var(--cyan);background:#e7f9fc;color:#05566a;font-weight:900}.cell.now{border:4px solid var(--ink);background:var(--cyan);color:#fff;font-weight:900;box-shadow:4px 4px 0 var(--ink)}.lane.wait .cell.now{background:var(--mag)}.detail{grid-column:2 / 6;border:3px solid var(--ink);border-top:0;background:var(--panel);padding:12px;display:flex;align-items:center;justify-content:space-between;gap:12px}.stats{display:flex;gap:8px;flex-wrap:wrap}.stats span,.merges span{border:2px solid var(--ink);padding:7px;font-size:12px;font-weight:900}.next{background:var(--mag);color:#fff;border:2px solid var(--ink);padding:9px;font-weight:900}.open,.nolink{min-height:44px;border:2px solid var(--ink);background:var(--panel);color:var(--ink);font:800 12px ui-monospace,SFMono-Regular,Consolas,monospace;display:inline-flex;align-items:center;justify-content:center;padding:8px 11px;text-decoration:none;white-space:nowrap}.open{background:var(--ink);color:#fff}.nolink{color:#777}.open:focus-visible{outline:4px solid var(--mag);outline-offset:2px}.empty{border:3px solid var(--ink);background:var(--panel);padding:30px;text-align:center;font-weight:900}footer{display:grid;grid-template-columns:1fr 2fr;gap:18px;margin-top:24px}.foot{border-top:4px solid var(--ink);padding:14px 0}.foot h2{font-size:12px;text-transform:uppercase;margin:0 0 10px}.foot p{display:flex;flex-direction:column;gap:3px;margin:8px 0}.merges{display:flex;flex-wrap:wrap;gap:8px}
@media(prefers-color-scheme:dark){:root{--ink:#f2f2ed;--paper:#090909;--panel:#121212;--cyan:#00f0ff;--mag:#ff2bd6;--soft:#383838}.need,.lane.wait .cell.now{color:#050505}.cell.done{background:#082b31;color:#7df7ff}.cell.now{color:#050505}.open{background:#f2f2ed;color:#090909}.asof{color:#aaa}}
@media(max-width:760px){.board{padding:14px}.axis{display:none}.lane{grid-template-columns:1fr 1fr;margin:24px 0;border:3px solid var(--ink);padding:12px;background:var(--panel)}.who{grid-column:1 / -1}.cell{min-height:64px;flex-direction:row}.cell span{display:block}.detail{grid-column:1 / -1;border:0;padding:10px 0 0;display:grid;grid-template-columns:1fr}.open,.nolink{width:100%}footer{grid-template-columns:1fr}.top strong{font-size:15px}.need{font-size:12px;padding:8px}.dates,.asof{text-align:left;line-height:1.5}}
@media(max-width:410px){.board{padding:12px}.top{align-items:stretch;flex-direction:column}.need{text-align:center}.lane{grid-template-columns:1fr 1fr}.who,.detail{grid-column:1 / -1}.cell{justify-content:flex-start;min-width:0}.stats{display:grid;grid-template-columns:1fr}.stats span,.next{text-align:center}}
</style>
</head>
<body>
<div class="board">
<header class="top"><strong>${escapeText(countdown(board.goLive, now))}</strong><span class="need">${needYou} NEED YOU</span></header>
<div class="dates">${escapeText(dates)}</div>
<div class="asof">as of ${escapeText(dateTime(now))}</div>
<div class="axis"><span>Chat</span><span>Review</span><span>CI</span><span>E2E</span><span>Merge</span></div>
<main>${tiles}</main>
<footer><section class="foot"><h2>Background</h2>${backgroundItems}</section><section class="foot"><h2>Merged today</h2><div class="merges">${merges}</div></section></footer>
</div>
</body>
</html>
`;
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

async function lastRender(path: string): Promise<number | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof value === "object" &&
			value !== null &&
			"renderedAt" in value &&
			typeof value.renderedAt === "number" &&
			Number.isFinite(value.renderedAt)
		) {
			return value.renderedAt;
		}
		return undefined;
	} catch (error) {
		if (isMissingFile(error) || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function validateThrottleKey(key: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
		throw new Error(
			"--throttle-key must start with a letter or number and contain only letters, numbers, periods, underscores, or hyphens",
		);
	}
}

export async function writeOverwatchSnapshot(
	board: OverwatchBoard,
	options: SnapshotOptions = {},
): Promise<SnapshotWriteResult> {
	const now = options.now ?? new Date();
	const scratchRoot = options.scratchRoot ?? SNAPSHOT_DIRECTORY;
	const requestedOutput = options.outPath ?? join(scratchRoot, "snapshot.html");
	const outPath = isAbsolute(requestedOutput)
		? requestedOutput
		: resolve(requestedOutput);
	let statePath: string | undefined;

	if (options.throttleKey) {
		validateThrottleKey(options.throttleKey);
		statePath = join(scratchRoot, `${options.throttleKey}.json`);
		const renderedAt = await lastRender(statePath);
		if (renderedAt !== undefined) {
			const elapsed = Math.max(0, now.getTime() - renderedAt);
			if (elapsed < THROTTLE_WINDOW_MS) {
				return {
					status: "throttled",
					seconds: Math.ceil((THROTTLE_WINDOW_MS - elapsed) / 1000),
				};
			}
		}
	}

	await mkdir(dirname(outPath), { recursive: true });
	await writeFile(outPath, renderOverwatchSnapshot(board, now), "utf8");
	if (statePath) {
		await mkdir(dirname(statePath), { recursive: true });
		await writeFile(statePath, JSON.stringify({ renderedAt: now.getTime() }), "utf8");
	}
	return { status: "written", path: outPath };
}

async function stdinText(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function readBoard(input: string): Promise<OverwatchBoard> {
	const source = input === "-" ? await stdinText() : await readFile(input, "utf8");
	const board: unknown = JSON.parse(source);
	const frame = validateChatFrame({
		type: "overwatch-state",
		sessionId: OVERWATCH_SESSION_ID,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		board,
	});
	if (frame.type !== "overwatch-state") {
		throw new Error("input is not an overwatch board");
	}
	return frame.board;
}

export function registerOverwatchSnapshot(program: Command): void {
	program
		.command("overwatch-snapshot")
		.description("render an Overwatch board JSON snapshot as read-only HTML")
		.option("--input <file>", "board JSON file, or - for stdin", "-")
		.option("--out <file>", "HTML output path")
		.option("--throttle-key <name>", "skip renders within 120 seconds for this key")
		.action(
			async (options: {
				input: string;
				out?: string;
				throttleKey?: string;
			}) => {
				const result = await writeOverwatchSnapshot(
					await readBoard(options.input),
					{
						outPath: options.out,
						throttleKey: options.throttleKey,
					},
				);
				console.log(
					result.status === "written"
						? result.path
						: `throttled: next publish in ${result.seconds}s`,
				);
			},
		);
}
