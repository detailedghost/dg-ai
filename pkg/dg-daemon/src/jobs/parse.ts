import type { FeedItemInput } from "../store";

export type ParseFeedResult =
	| { ok: true; items: FeedItemInput[] }
	| { ok: false; error: string };

function optionalString(
	value: unknown,
	field: string,
	line: number,
): { ok: true; value?: string } | { ok: false; error: string } {
	if (value === undefined || value === null) return { ok: true };
	if (typeof value !== "string") {
		return { ok: false, error: `line ${line}: "${field}" must be a string` };
	}
	return { ok: true, value };
}

/**
 * Read a job's stdout as one feed item per line. A job speaks JSON lines so the daemon
 * needs no Jira, Datadog or Sentry code of its own, and so dedupe has a stable key.
 */
export function parseFeedLines(stdout: string): ParseFeedResult {
	const items: FeedItemInput[] = [];
	const seen = new Set<string>();

	const lines = stdout.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index].trim();
		if (!raw) continue;
		const line = index + 1;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { ok: false, error: `line ${line}: not valid JSON` };
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return { ok: false, error: `line ${line}: expected a JSON object` };
		}

		const record = parsed as Record<string, unknown>;
		const id = record.id;
		if (typeof id !== "string" || id.length === 0) {
			return {
				ok: false,
				error: `line ${line}: "id" must be a non-empty string`,
			};
		}
		const title = record.title;
		if (typeof title !== "string" || title.length === 0) {
			return {
				ok: false,
				error: `line ${line}: "title" must be a non-empty string`,
			};
		}

		const meta = optionalString(record.meta, "meta", line);
		if (!meta.ok) return meta;
		const url = optionalString(record.url, "url", line);
		if (!url.ok) return url;

		if (seen.has(id)) continue;
		seen.add(id);
		items.push({
			fingerprint: id,
			title,
			...(meta.value === undefined ? {} : { meta: meta.value }),
			...(url.value === undefined ? {} : { url: url.value }),
		});
	}

	return { ok: true, items };
}
