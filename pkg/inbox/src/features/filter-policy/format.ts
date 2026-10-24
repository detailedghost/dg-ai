import type { SyncPlan } from "./plan";
import { planHash } from "./plan";
import type { SafetyIssue } from "./safety";

export function formatSyncReview(
	plan: SyncPlan,
	issues: SafetyIssue[],
): string {
	const lines: string[] = [];
	for (const action of plan.actions) {
		lines.push(actionLine(action));
	}
	for (const notice of plan.notices) {
		if (notice.op === "rename-proposal") {
			lines.push(
				`RENAME PROPOSAL ${notice.target} ${notice.from} -> ${notice.to} (${notice.reason})`,
			);
		} else if (notice.op === "drift") {
			lines.push(`DRIFT ${notice.target} ${notice.name} [${notice.id}] ${notice.detail}`);
		} else {
			lines.push(
				`DELETE WITHHELD ${notice.target} ${notice.name} [${notice.id}]`,
			);
		}
	}
	for (const issue of issues) {
		lines.push(`BLOCKED ${issue.code}: ${issue.message}`);
	}
	if (lines.length === 0) lines.push("No Proton changes.");
	lines.push(`plan ${planHash(plan)}`);
	return lines.join("\n");
}

function actionLine(action: SyncPlan["actions"][number]): string {
	switch (action.op) {
		case "create-filter":
			return `CREATE filter ${action.name}`;
		case "update-filter":
			return action.changes.length === 1 && action.changes[0] === "name"
				? `RENAME filter ${action.fromName} -> ${action.name}`
				: `UPDATE filter ${action.name} (${action.changes.join(", ")})`;
		case "reorder-filters":
			return `REORDER filters ${action.names.join(" | ")}`;
		case "delete-filter":
			return `DELETE filter ${action.name} [${action.id}]`;
		case "create-folder":
			return `CREATE folder ${action.path}`;
		case "rename-folder":
			return `RENAME folder ${action.from} -> ${action.to}`;
		case "delete-folder":
			return `DELETE folder ${action.path} [${action.id}]`;
		case "pull-filter":
			return `PULL filter ${action.name} [${action.id}]`;
		case "pull-folder":
			return `PULL folder ${action.path} [${action.id}]`;
		case "revert-filter":
			return `REVERT filter ${action.name} [${action.id}]`;
	}
}
