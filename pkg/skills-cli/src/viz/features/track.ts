import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { vizConfig } from "../config";
import { die } from "../io";
import { validateSlug } from "../session";
import { PHASE_STATUSES } from "./phase";

interface TrackOpts {
	progress?: number;
	detail?: string;
	label?: string;
	agent?: string;
}

export function runTrack(
	slug: string,
	id: string,
	status: string,
	opts: TrackOpts,
): void {
	try {
		validateSlug(slug);
	} catch (e) {
		die(`invalid slug — ${(e as Error).message}`);
	}

	try {
		validateSlug(id);
	} catch (e) {
		die(`invalid track-id — traversal guard: ${(e as Error).message}`);
	}

	if (!PHASE_STATUSES.includes(status)) {
		die(
			`invalid status "${status}" — must be one of: ${PHASE_STATUSES.join(", ")}`,
		);
	}

	if (opts.progress !== undefined) {
		if (
			!Number.isFinite(opts.progress) ||
			opts.progress < 0 ||
			opts.progress > 100
		) {
			die(`--progress ${opts.progress} is out of range — must be 0–100`);
		}
	}

	const tracksDir = `${vizConfig().vizDir}/${slug}/tracks`;
	mkdirSync(tracksDir, { recursive: true });

	const record: Record<string, unknown> = { id, status };
	if (opts.progress !== undefined) record.progress = opts.progress;
	if (opts.detail !== undefined) record.detail = opts.detail;
	if (opts.label !== undefined) record.label = opts.label;
	if (opts.agent !== undefined) record.agent = opts.agent;

	const tmpPath = `${tracksDir}/${id}.json.tmp`;
	writeFileSync(tmpPath, JSON.stringify(record));
	renameSync(tmpPath, `${tracksDir}/${id}.json`);
}

export function cmdTrack(args: string[]): void {
	const [slug, id, status, ...flags] = args;
	if (!slug || !id || !status) {
		die(
			"usage: dg-skills viz track <slug> <track-id> <status> [--progress N] [--detail s] [--label s] [--agent s]",
		);
	}

	const opts: TrackOpts = {};
	for (let i = 0; i < flags.length; i++) {
		const flag = flags[i];
		const next = flags[i + 1];
		if (flag === "--progress" && next !== undefined) {
			opts.progress = Number(next);
			i++;
		} else if (flag === "--detail" && next !== undefined) {
			opts.detail = next;
			i++;
		} else if (flag === "--label" && next !== undefined) {
			opts.label = next;
			i++;
		} else if (flag === "--agent" && next !== undefined) {
			opts.agent = next;
			i++;
		}
	}

	runTrack(slug, id, status, opts);
}
