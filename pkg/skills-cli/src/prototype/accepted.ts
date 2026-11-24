import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { readSignIn } from "./signin";

const SHOTS_DIR = "accepted";

export interface AcceptTarget {
	dir: string;
	name: string;
	chain: string;
	labels?: Record<string, string>;
	signIn?: string;
	stateName?: string;
}

export interface CaptureAccess {
	signIn?: string;
	stateName?: string;
}

export const FINGERPRINT_TIMEOUT_MS = 60_000;
const TIMED_OUT = "timed out after ";

export interface AcceptSeams {
	open: () => Promise<Capturer>;
	now: () => Date;
	timeoutMs: number;
}

const DEFAULT_SEAMS: AcceptSeams = {
	open: () => openPlaywrightCapturer(),
	now: () => new Date(),
	timeoutMs: FINGERPRINT_TIMEOUT_MS,
};

interface Captured {
	fingerprint: Fingerprint | null;
	skipped: string | null;
	shots: boolean;
}

function withStoredAccess<T extends CaptureAccess>(dir: string, given: T): T {
	const stored = readSignIn(dir);
	const signIn = given.signIn ?? stored.signIn;
	const stateName = given.stateName ?? stored.stateName;
	return { ...given, ...(signIn ? { signIn } : {}), ...(stateName ? { stateName } : {}) };
}

const rootSelector = (name: string): string => `[data-verify-root="${name}"]`;

const repair = (name: string, signIn = false): string =>
	`run prototype fingerprint ${name} --url=<loopback-url>${signIn ? " --sign-in=<loopback-url>" : ""}`;

const redirected = (target: URL, finalUrl: string): string | undefined => {
	try {
		const landed = new URL(finalUrl);
		return landed.pathname === target.pathname ? undefined : landed.pathname;
	} catch {
		return undefined;
	}
};

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
	{ signIn, stateName }: CaptureAccess = {},
): Promise<Captured> {
	const none = (skipped: string): Captured => ({ fingerprint: null, skipped, shots: false });
	const fix = repair(name, signIn !== undefined);
	if (!url) return none(`no page url recorded; ${fix}`);
	let page: URL;
	try {
		page = new URL(url);
	} catch {
		return none(`page url is not a valid url; ${fix}`);
	}
	if (!isLoopbackUrl(page))
		return none(`page url is not on loopback; ${fix}`);
	if (signIn !== undefined && !URL.canParse(signIn))
		return none(`sign-in url is not a valid url; ${fix}`);
	if (signIn !== undefined && !isLoopbackUrl(new URL(signIn)))
		return none(`sign-in url is not on loopback; ${fix}`);
	if (signIn !== undefined && new URL(signIn).origin !== page.origin)
		return none(`sign-in url is not on the page url's origin ${page.origin}; ${fix}`);
	let opened: Capturer | undefined;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<Captured>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			resolve(none(`${TIMED_OUT}${seams.timeoutMs / 1000}s; ${fix}`));
		}, seams.timeoutMs);
	});
	const work = (async (): Promise<Captured> => {
		try {
			opened = await seams.open();
		} catch (error) {
			return none(`browser unavailable (${firstLine(error)}); ${fix}`);
		}
		if (timedOut) {
			await opened.close().catch(() => undefined);
			return none(`${TIMED_OUT}${seams.timeoutMs / 1000}s; ${fix}`);
		}
		return captureShots(dir, name, variant, page, opened, fix, { signIn, stateName }, () => timedOut);
	})();
	try {
		return await Promise.race([work, bound]);
	} finally {
		clearTimeout(timer);
		await opened?.close().catch(() => undefined);
	}
}

async function captureShots(
	dir: string,
	name: string,
	variant: string,
	page: URL,
	capturer: Capturer,
	fix: string,
	{ signIn, stateName }: CaptureAccess,
	stopped: () => boolean,
): Promise<Captured> {
	const root = rootSelector(name);
	const readings: Reading[] = [];
	let skipped: string | null = null;
	let shots = false;
	try {
		rmSync(join(dir, SHOTS_DIR), { recursive: true, force: true });
		mkdirSync(join(dir, SHOTS_DIR), { recursive: true });
		for (const viewport of VIEWPORTS) {
			for (const theme of THEMES) {
				if (stopped()) return { fingerprint: null, skipped: "stopped", shots };
				const target = new URL(page);
				target.searchParams.set("variant", variant);
				target.searchParams.set("mode", theme);
				target.searchParams.delete("width");
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
					...(signIn ? { signIn } : {}),
					...(stateName ? { stateName } : {}),
				});
				if (stopped()) return { fingerprint: null, skipped: "stopped", shots };
				writeFileSync(join(dir, SHOTS_DIR, `${viewport.id}-${theme}.png`), shot.png);
				shots = true;
				if (!shot.fingerprint || "error" in shot.fingerprint) {
					const reason = shot.fingerprint?.error ?? "root: no layout reading returned";
					const landed = redirected(target, shot.finalUrl);
					skipped ??= landed
						? `${reason}; the page redirected to ${landed}, so it may need a sign-in; ${repair(name, true)}`
						: reason;
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
		skipped = `capture failed (${firstLine(error)}); ${fix}`;
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
	const accepted = build(
		await readLayouts(target.dir, target.name, claim.variant, claim.url, seams, target),
	);
	store(target.dir, accepted);
	return accepted;
}

/** Read the layout again for an existing record, from a loopback page URL. */
export async function refingerprint(
	dir: string,
	name: string,
	url: string,
	overrides: Partial<AcceptSeams> = {},
	access: CaptureAccess = {},
): Promise<AcceptedRecord> {
	const resolved = withStoredAccess(dir, access);
	const { signIn } = resolved;
	const prior = loadRecord(dir);
	if (!prior) throw new Error(`nothing accepted for "${name}"`);
	if (!isLoopbackUrl(new URL(url))) throw new Error("refused non-loopback url");
	if (signIn !== undefined && !isLoopbackUrl(new URL(signIn))) throw new Error("refused non-loopback sign-in url");
	const captured = await readLayouts(dir, name, prior.variant, url, { ...DEFAULT_SEAMS, ...overrides }, resolved);
	const shotsDir = join(dir, SHOTS_DIR);
	const keptShots = existsSync(shotsDir) && readdirSync(shotsDir).length > 0;
	const updated: AcceptedRecord = {
		...prior,
		url,
		fingerprint: captured.fingerprint,
		skipped: captured.skipped,
		shots: captured.shots ? `${SHOTS_DIR}/` : keptShots ? prior.shots : null,
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

function repairLine(target: AcceptTarget, url = "<url>"): string {
	const access = [
		`--url=${url}`,
		...(target.stateName ? [`--state=${target.stateName}`] : []),
		...(target.signIn ? ["--sign-in=<url>"] : []),
		...(!target.stateName && !target.signIn ? ["--state=<name>"] : []),
	];
	return `run: dg prototype fingerprint ${target.name} ${access.join(" ")}`;
}

/** Build the claim hook that records an approve and tells stderr where the record went. */
export function acceptanceHook(
	given: AcceptTarget,
	overrides: Partial<AcceptSeams> = {},
): ApproveHook {
	return async (claim) => {
		try {
			const target = withStoredAccess(given.dir, given);
			const accepted = await recordAcceptance(target, claim, overrides);
			const outcome = accepted.fingerprint
				? fingerprintSummary(accepted)
				: `skipped: ${accepted.skipped}`;
			process.stderr.write(`prototype: recorded ${recordPath(target.dir)} (${outcome})\n`);
			const fromPage = claim.url !== undefined || claim.source === "browser";
			if (accepted.skipped === null || !fromPage) return undefined;
			if (accepted.skipped.startsWith(TIMED_OUT)) {
				process.stderr.write(`prototype: fingerprint ${accepted.skipped.split(";")[0]}; the pick is recorded\n${repairLine(target, claim.url)}\n`);
				return undefined;
			}
			process.stderr.write(
				`prototype: fingerprint skipped: ${accepted.skipped}\n${repairLine(target, claim.url)}\n`,
			);
			return accepted.skipped;
		} catch (error) {
			process.stderr.write(`prototype: warning: could not record the acceptance: ${firstLine(error)}\n`);
			return undefined;
		}
	};
}
