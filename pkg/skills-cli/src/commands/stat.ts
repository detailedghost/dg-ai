import { oneOf, parseFlag, parseOptionalFlag, wholeNumber } from "@dg/common";
import type { Command } from "commander";
import {
	addItem,
	checklistPath,
	ETA_BUCKETS,
	type EtaBucket,
	markDone,
	readChecklist,
	renderEmoji,
	renderJsonModel,
	renderLong,
	renderPlain,
	setStatus,
	type ChecklistModel,
	type Status,
	STATUSES,
	updateChecklist,
} from "../stat";

function parseEta(value: string): EtaBucket {
	return parseFlag(oneOf(ETA_BUCKETS), value, "--eta");
}

function parseStatusArg(value: string): Status {
	return parseFlag(oneOf(STATUSES), value, "status");
}

function storedAddedText(model: ChecklistModel, label: string): string {
	const dot = label.indexOf(".");
	const topIndex = Number(dot === -1 ? label : label.slice(0, dot)) - 1;
	const parent = model.open[topIndex];
	if (!parent) return "";
	if (dot === -1) return parent.text;
	const childIndex = Number(label.slice(dot + 1)) - 1;
	return parent.children[childIndex]?.text ?? "";
}

function reportMatchFailure(
	verb: string,
	match: string,
	candidates: { label: string; text: string }[],
): never {
	if (candidates.length === 0) {
		throw new Error(`${verb}: no checklist item matches "${match}"`);
	}
	const list = candidates.map((c) => `  ${c.label} ${c.text}`).join("\n");
	throw new Error(
		`${verb}: "${match}" matches ${candidates.length} items; be more specific:\n${list}`,
	);
}

/** Registers the checklist that /dg:stat renders by default, plus --long, --plain and --json views. */
export function registerStat(program: Command): void {
	const stat = program
		.command("stat")
		.description(
			"Track a priority-ordered checklist of agent and user work, for /dg:stat",
		);

	stat
		.command("checklist")
		.description(
			"Print the checklist: emoji view by default, --long for a POSIX table, --plain for ASCII/GFM, --json for data",
		)
		.option("-l, --long", "print a POSIX tab-separated table instead")
		.option("-p, --plain", "print an ASCII, GitHub-flavored-markdown view instead")
		.option("--json", "print the checklist as JSON instead")
		.action((options: { long?: boolean; plain?: boolean; json?: boolean }) => {
			const picked = [options.long, options.plain, options.json].filter(Boolean).length;
			if (picked > 1) throw new Error("checklist: pass only one of --long, --plain, --json");
			const model = readChecklist(checklistPath());
			if (options.json) console.log(JSON.stringify(renderJsonModel(model)));
			else if (options.long) process.stdout.write(renderLong(model));
			else if (options.plain) process.stdout.write(renderPlain(model));
			else process.stdout.write(renderEmoji(model));
		});

	stat
		.command("add")
		.description("Append (or place) a new open checklist item")
		.argument("<text>", "item text")
		.option(
			"--status <name>",
			`one of ${STATUSES.filter((s) => s !== "done").join(", ")} (default queued)`,
		)
		.option("--eta <bucket>", `one of ${ETA_BUCKETS.join(", ")}`)
		.option("--at <n>", "1-based position among open top-level items (default: end)")
		.option("--under <nOrMatch>", "add as a sub-item of this open top-level item")
		.action(
			async (
				text: string,
				options: { status?: string; eta?: string; at?: string; under?: string },
			) => {
				if (options.status === "done") {
					throw new Error(
						'add: use "stat done <match>" to mark an item done, not --status done',
					);
				}
				if (options.at !== undefined && options.under !== undefined) {
					throw new Error("add: pass only one of --at or --under");
				}
				const status = options.status ? parseStatusArg(options.status) : undefined;
				const eta = options.eta ? parseEta(options.eta) : undefined;
				const at = parseOptionalFlag(wholeNumber(1), options.at, "add: --at");
				const path = checklistPath();
				const result = await updateChecklist(path, (model) => {
					const added = addItem(model, text, { status, eta, at, under: options.under });
					if (!added.ok) reportMatchFailure("add", options.under ?? "", added.candidates);
					return added;
				});
				console.log(
					JSON.stringify({
						kind: "checklist-item-added",
						order: result.label,
						text: storedAddedText(result.model, result.label),
					}),
				);
			},
		);

	stat
		.command("done")
		.description("Mark the one unfinished item matching <match> as done")
		.argument("<match>", "case-insensitive substring of the item text")
		.action(async (match: string) => {
			const path = checklistPath();
			const result = await updateChecklist(path, (model) => {
				const marked = markDone(model, match);
				if (!marked.ok) reportMatchFailure("done", match, marked.candidates);
				return marked;
			});
			console.log(JSON.stringify({ kind: "checklist-item-done", order: result.label }));
		});

	stat
		.command("status")
		.description(
			"Change an item's status (and optionally its ETA); setting a done item's status away from done reopens it",
		)
		.argument("<match>", "case-insensitive substring of the item text")
		.argument("<name>", `one of ${STATUSES.join(", ")}`)
		.option("--eta <bucket>", `one of ${ETA_BUCKETS.join(", ")}`)
		.action(async (match: string, name: string, options: { eta?: string }) => {
			const status = parseStatusArg(name);
			const eta = options.eta ? parseEta(options.eta) : undefined;
			const path = checklistPath();
			const result = await updateChecklist(path, (model) => {
				const updated = setStatus(model, match, status, eta);
				if (!updated.ok) reportMatchFailure("status", match, updated.candidates);
				return updated;
			});
			console.log(
				JSON.stringify({ kind: "checklist-item-status", order: result.label, status }),
			);
		});
}
