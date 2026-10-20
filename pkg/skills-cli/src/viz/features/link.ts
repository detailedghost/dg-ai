import { sessionUrl } from "../config";
import { die, note } from "../io";
import { ensureServer, openUrlOnce } from "../server";
import { mutatePayload, validateSlug } from "../session";

const KINDS = ["pr", "jira", "doc", "other"];

interface LinkEntry {
	label: string;
	url: string;
	kind: string;
	status: string;
}

/** Upsert or remove a top-of-board link. */
export async function cmdLink(rest: string[]): Promise<void> {
	const [rawSlug, target, ...flags] = rest;
	if (!rawSlug || !target)
		die(
			"usage: dg-skills viz link <slug> <url|label> [--label s] [--kind pr|jira|doc|other] [--status s] [--remove]",
		);
	const slug = validateSlug(rawSlug);

	let label: string | undefined;
	let kind = "pr";
	let status: string | undefined;
	let remove = false;
	for (let i = 0; i < flags.length; i++) {
		const f = flags[i];
		if (f === "--remove") remove = true;
		else if (f === "--label") label = flags[++i];
		else if (f === "--kind") kind = flags[++i];
		else if (f === "--status") status = flags[++i];
		else die(`unknown flag '${f}'`);
	}
	if (!KINDS.includes(kind))
		die(`invalid kind '${kind}' — one of: ${KINDS.join(", ")}`);

	const isUrl = /^https?:\/\//.test(target);
	const url = isUrl ? target : "";
	const key = target;

	let action = "";

	await mutatePayload(slug, (payload) => {
		const links = ((payload.links as LinkEntry[] | undefined) ?? []).slice();
		const idx = links.findIndex((l) =>
			isUrl ? l.url === key : l.label === key && !l.url,
		);

		if (remove) {
			if (idx === -1) throw new Error(`no link matching '${key}' in ${slug}`);
			links.splice(idx, 1);
			action = "removed";
		} else if (idx === -1) {
			links.push({
				label: label ?? target,
				url,
				kind,
				status: status ?? "",
			});
			action = "added";
		} else {
			const existing = links[idx];
			if (label !== undefined) existing.label = label;
			if (status !== undefined) existing.status = status;
			existing.kind = kind;
			if (isUrl) existing.url = url;
			action = "updated";
		}

		payload.links = links;
	});

	await ensureServer();
	openUrlOnce(slug, sessionUrl(slug));
	note(`${slug}: link ${action} — ${label ?? target}`);
}
