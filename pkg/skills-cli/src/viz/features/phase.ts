import { sessionUrl } from "../config";
import { die, note } from "../io";
import { ensureServer, openUrlOnce } from "../server";
import { mutatePayload, validateSlug } from "../session";

export const PHASE_STATUSES = [
	"pending",
	"in_progress",
	"done",
	"partial",
	"blocked",
	"skipped",
];

export async function cmdPhase(rest: string[]): Promise<void> {
	const [rawSlug, id, status] = rest;
	if (!rawSlug || !id || !status)
		die("usage: dg-skills viz phase <slug> <phase-id> <status>");
	const slug = validateSlug(rawSlug);
	if (!PHASE_STATUSES.includes(status))
		die(`invalid status '${status}' — one of: ${PHASE_STATUSES.join(", ")}`);

	let phaseCount = 0;
	let doneCount = 0;

	await mutatePayload(slug, (payload) => {
		if (payload.template === "spec") {
			throw new Error(
				"spec implementation is tracked in the spec file — update slice status there, not the ephemeral viz board",
			);
		}
		const phases = (payload.phases ?? []) as Record<string, unknown>[];
		const target = phases.find(
			(p) => String(p.id) === id || String(p.label) === id,
		);
		if (!target) throw new Error(`no phase with id/label '${id}' in ${slug}`);
		target.status = status;

		phaseCount = phases.length;
		doneCount = phases.filter((p) => p.status === "done").length;
	});

	await ensureServer();
	openUrlOnce(slug, sessionUrl(slug));
	note(`${slug}: phase '${id}' → ${status} (${doneCount}/${phaseCount} done)`);
}
