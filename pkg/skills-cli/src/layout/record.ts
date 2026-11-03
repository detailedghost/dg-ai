import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Fingerprint } from "./fingerprint";

export const RECORD_FILE = "accepted.json";

const box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

const control = z.object({
	i: z.number(),
	role: z.string(),
	name: z.string(),
	testid: z.string().nullable(),
	path: z.string(),
	box,
	band: z.enum(["top", "middle", "bottom"]),
	hband: z.enum(["left", "center", "right"]),
	visible: z.boolean(),
	occluded: z.boolean(),
	occluder: z.string().nullable(),
});

const reading = z.object({
	viewport: z.enum(["desktop", "tablet", "mobile"]),
	width: z.number(),
	height: z.number(),
	theme: z.enum(["light", "dark"]),
	themeApplied: z.enum(["light", "dark", "unknown"]),
	root: box.nullable(),
	controls: z.array(control),
});

const fingerprint = z.object({
	version: z.literal(1),
	root: z.string(),
	readings: z.array(reading),
});

const historyEntry = z.object({
	round: z.number(),
	variant: z.string(),
	notes: z.string(),
	at: z.string(),
});

const record = z.object({
	version: z.literal(1),
	name: z.string(),
	chain: z.string(),
	mode: z.enum(["local", "ext"]),
	variant: z.string(),
	label: z.string().optional(),
	round: z.number(),
	notes: z.string(),
	final: z.boolean(),
	source: z.string(),
	at: z.string(),
	url: z.string().nullable(),
	root: z.string().nullable(),
	fingerprint: fingerprint.nullable(),
	skipped: z.string().nullable(),
	shots: z.string().nullable(),
	history: z.array(historyEntry),
});

export type AcceptedRecord = z.infer<typeof record> & { fingerprint: Fingerprint | null };

export function parseRecord(raw: unknown): AcceptedRecord {
	return record.parse(raw) as AcceptedRecord;
}

/** Read and validate a record file; a missing or malformed file throws with the path named. */
export function readRecord(path: string): AcceptedRecord {
	try {
		return parseRecord(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		throw new Error(
			`unreadable accepted record ${path}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
		);
	}
}

export function fingerprintSummary(value: AcceptedRecord): string {
	return value.fingerprint
		? `${value.fingerprint.readings.length} readings`
		: `none: ${value.skipped ?? "not recorded"}`;
}

const cell = (text: string): string => text.replace(/\|/g, "\\|");

/** Render the text-only page a plan links; it never references an image. */
export function renderAccepted(
	value: AcceptedRecord,
	options: { sandbox: string; waived?: boolean },
): string {
	const lines = [
		`# Accepted prototype: ${value.name}`,
		"",
		`- Sandbox: ${options.sandbox}`,
		`- Variant: ${value.variant}${value.label ? ` (${value.label})` : ""}`,
		`- Round: ${value.round}${value.final ? " (final)" : ""}`,
		`- Decided: ${value.at} by ${value.source}`,
		`- Verdict note: ${value.notes || "none"}`,
		`- Feature root: ${value.root ? `\`${value.root}\`` : "none"}`,
		`- Fingerprint: ${fingerprintSummary(value)}`,
	];
	if (!value.fingerprint)
		lines.push(
			`- Reason: ${value.skipped ?? "no fingerprint recorded"}${options.waived ? "; accepted without a fingerprint with --no-fingerprint" : ""}`,
		);
	for (const found of value.fingerprint?.readings ?? []) {
		lines.push(
			"",
			`## ${found.viewport} ${found.theme} (${found.width}x${found.height})`,
			"",
			"| # | role | name | test id | band | visible |",
			"| --- | --- | --- | --- | --- | --- |",
			...found.controls.map(
				(item) =>
					`| ${item.i + 1} | ${cell(item.role)} | ${cell(item.name)} | ${cell(item.testid ?? "-")} | ${item.band}/${item.hband} | ${item.visible ? "yes" : "no"} |`,
			),
		);
	}
	return `${lines.join("\n")}\n`;
}
