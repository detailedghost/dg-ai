import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fingerprint, Reading } from "../layout/fingerprint";
import {
	type AcceptedRecord,
	fingerprintSummary,
	RECORD_FILE,
	readRecord,
} from "../layout/record";
import { THEMES, VIEWPORTS, type Capturer } from "../verify/capture-model";
import { openPlaywrightCapturer } from "../verify/playwright-capturer";
import { isLoopbackUrl } from "../verify/urls";
import { type ApprovedClaim, type ApproveHook, writeSentinel } from "./sentinels";

const SHOTS_DIR = "accepted";

export interface AcceptTarget {
	dir: string;
	name: string;
	chain: string;
	labels?: Record<string, string>;
}

export interface AcceptSeams {
	open: () => Promise<Capturer>;
	now: () => Date;
}

const DEFAULT_SEAMS: AcceptSeams = {
	open: () => openPlaywrightCapturer(),
	now: () => new Date(),
};

interface Captured {
	fingerprint: Fingerprint | null;
	skipped: string | null;
	shots: boolean;
}

const rootSelector = (name: string): string => `[data-verify-root="${name}"]`;

const repair = (name: string): string =>
	`run prototype fingerprint ${name} --url=<loopback-url>`;

const firstLine = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

function recordPath(dir: string): string {
	return join(dir, RECORD_FILE);
}

function store(dir: string, value: AcceptedRecord): void {
	mkdirSync(dir, { recursive: true });
	writeSentinel(recordPath(dir), `${JSON.stringify(value, null, 2)}\n`);
}

/** The record already in a sandbox directory, or undefined when none is readable. */
export function loadRecord(dir: string): AcceptedRecord | undefined {
	try {
		return readRecord(recordPath(dir));
	} catch {
		return undefined;
	}
}

async function readLayouts(
	dir: string,
	name: string,
	variant: string,
	url: string | undefined,
	seams: AcceptSeams,
): Promise<Captured> {
	const none = (skipped: string): Captured => ({ fingerprint: null, skipped, shots: false });
	if (!url) return none(`no page url recorded; ${repair(name)}`);
	let page: URL;
	try {
		page = new URL(url);
	} catch {
		return none(`page url is not a valid url; ${repair(name)}`);
	}
	if (!isLoopbackUrl(page))
		return none(`page url is not on loopback; ${repair(name)}`);
	let capturer: Capturer;
	try {
		capturer = await seams.open();
	} catch (error) {
		return none(`browser unavailable (${firstLine(error)}); ${repair(name)}`);
	}
	const root = rootSelector(name);
	const readings: Reading[] = [];
	let skipped: string | null = null;
	let shots = false;
	try {
		mkdirSync(join(dir, SHOTS_DIR), { recursive: true });
		for (const viewport of VIEWPORTS) {
			for (const theme of THEMES) {
				const target = new URL(page);
				target.searchParams.set("variant", variant);
				target.searchParams.set("mode", theme);
				const shot = await capturer.shot({
					url: target.toString(),
					headers: {},
					cookies: [],
					width: viewport.width,
					height: viewport.height,
					theme,
					state: "default",
					menuSelector: "[data-verify-menu]",
					fingerprintRoot: root,
				});
				writeFileSync(join(dir, SHOTS_DIR, `${viewport.id}-${theme}.png`), shot.png);
				shots = true;
				if (!shot.fingerprint || "error" in shot.fingerprint) {
					skipped ??= shot.fingerprint?.error ?? "root: no layout reading returned";
					continue;
				}
				readings.push({
					viewport: viewport.id,
					width: viewport.width,
					height: viewport.height,
					theme,
					themeApplied: shot.fingerprint.themeApplied,
					root: shot.fingerprint.root,
					controls: shot.fingerprint.controls,
				});
			}
		}
	} catch (error) {
		skipped = `capture failed (${firstLine(error)}); ${repair(name)}`;
	} finally {
		await capturer.close().catch(() => undefined);
	}
	return skipped === null
		? { fingerprint: { version: 1, root, readings }, skipped: null, shots }
		: { fingerprint: null, skipped, shots };
}

/** Write the acceptance record for a claimed approve; a missing browser or url becomes `skipped`, never a failure. */
export async function recordAcceptance(
	target: AcceptTarget,
	claim: ApprovedClaim,
	overrides: Partial<AcceptSeams> = {},
): Promise<AcceptedRecord> {
	const seams = { ...DEFAULT_SEAMS, ...overrides };
	const prior = loadRecord(target.dir);
	const at = seams.now().toISOString();
	const history = [
		...(prior && !prior.final ? prior.history : []),
		{ round: 0, variant: claim.variant, notes: claim.notes, at },
	].map((entry, index) => ({ ...entry, round: index + 1 }));
	const build = (captured: Captured): AcceptedRecord => ({
		version: 1,
		name: target.name,
		chain: target.chain,
		mode: "local",
		variant: claim.variant,
		...(target.labels?.[claim.variant] ? { label: target.labels[claim.variant] } : {}),
		round: history.length,
		notes: claim.notes,
		final: claim.notes === "",
		source: claim.source,
		at,
		url: claim.url ?? null,
		root: rootSelector(target.name),
		fingerprint: captured.fingerprint,
		skipped: captured.skipped,
		shots: captured.shots ? `${SHOTS_DIR}/` : null,
		history,
	});
	store(
		target.dir,
		build({
			fingerprint: null,
			skipped: `recording interrupted; run prototype fingerprint ${target.name} --url=<url>`,
			shots: false,
		}),
	);
	const accepted = build(await readLayouts(target.dir, target.name, claim.variant, claim.url, seams));
	store(target.dir, accepted);
	return accepted;
}

/** Read the layout again for an existing record, from a loopback page URL. */
export async function refingerprint(
	dir: string,
	name: string,
	url: string,
	overrides: Partial<AcceptSeams> = {},
): Promise<AcceptedRecord> {
	const prior = loadRecord(dir);
	if (!prior) throw new Error(`nothing accepted for "${name}"`);
	if (!isLoopbackUrl(new URL(url))) throw new Error("refused non-loopback url");
	const captured = await readLayouts(dir, name, prior.variant, url, { ...DEFAULT_SEAMS, ...overrides });
	const updated: AcceptedRecord = {
		...prior,
		url,
		fingerprint: captured.fingerprint,
		skipped: captured.skipped,
		shots: captured.shots ? `${SHOTS_DIR}/` : prior.shots,
	};
	store(dir, updated);
	return updated;
}

/** Mark the latest record final, as `prototype stop` does; no record means nothing to mark. */
export function markFinal(dir: string): void {
	const prior = loadRecord(dir);
	if (prior && !prior.final) store(dir, { ...prior, final: true });
}

export function acceptedSummary(dir: string) {
	const found = loadRecord(dir);
	return found
		? {
				variant: found.variant,
				round: found.round,
				final: found.final,
				fingerprint: fingerprintSummary(found),
			}
		: undefined;
}

/** Build the claim hook that records an approve and tells stderr where the record went. */
export function acceptanceHook(target: AcceptTarget): ApproveHook {
	return async (claim) => {
		try {
			const accepted = await recordAcceptance(target, claim);
			const outcome = accepted.fingerprint
				? fingerprintSummary(accepted)
				: `skipped: ${accepted.skipped}`;
			process.stderr.write(`prototype: recorded ${recordPath(target.dir)} (${outcome})\n`);
		} catch (error) {
			process.stderr.write(`prototype: warning: could not record the acceptance: ${firstLine(error)}\n`);
		}
	};
}
