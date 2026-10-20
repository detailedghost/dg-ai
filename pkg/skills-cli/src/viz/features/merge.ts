import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { hasFlag } from "../args";
import { sessionDir, sessionUrl } from "../config";
import { die, note } from "../io";
import { doMerge, KNOWN_TYPES, validateHmac } from "../respond-core";
import { ensureServer, openUrlOnce } from "../server";
import {
	clearStale,
	mutatePayload,
	readPayload,
	validateSlug,
} from "../session";

interface ResponseFile {
	slug?: string;
	answers?: {
		type: string;
		index: number;
		answer: string;
		note?: string;
		agent?: unknown;
		rec?: unknown;
	}[];
	hmac?: string;
}

export async function runMerge(slug: string, noOpen: boolean): Promise<void> {
	const responsePath = `${sessionDir(slug)}/response.json`;
	if (!existsSync(responsePath))
		die(`no response.json for ${slug} — nothing to merge`);

	const response = JSON.parse(
		readFileSync(responsePath, "utf-8"),
	) as ResponseFile;

	if (response.slug !== undefined && response.slug !== slug) {
		die(`response slug mismatch: expected "${slug}", got "${response.slug}"`);
	}

	const earlyPayload = readPayload(slug);
	const hasSecurityGate =
		earlyPayload.approval !== undefined ||
		Array.isArray(earlyPayload.permissions);

	const hmacResult = validateHmac(
		slug,
		response.answers ?? [],
		response.hmac,
		hasSecurityGate,
	);
	if (hmacResult === false) {
		die("response.json HMAC invalid or missing — file rejected");
	}

	const answers = (response.answers ?? []).filter((ans) =>
		KNOWN_TYPES.has(ans.type),
	);

	let summary: unknown;
	await mutatePayload(slug, (payload) => {
		summary = doMerge(payload, answers);
	});

	unlinkSync(responsePath);
	clearStale(slug);

	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

	await ensureServer();
	if (!noOpen) openUrlOnce(slug, sessionUrl(slug));
	note(`merged → ${sessionUrl(slug)}`);
}

export async function cmdMerge(rest: string[]): Promise<void> {
	const rawSlug = rest[0];
	if (!rawSlug) die("usage: dg-skills viz merge <slug> [--no-open]");
	const slug = validateSlug(rawSlug);
	await runMerge(slug, hasFlag(rest, "--no-open"));
}
