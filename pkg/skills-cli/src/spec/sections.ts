import {
	awkEquals,
	awkNumber,
	die,
	flagValue,
	joinRecords,
	needFile,
	PROGRAM,
	readText,
	records,
	replaceText,
	say,
	usageError,
} from "./shared";

/** Lines of the first `## <prefix>` section, awk-style: a repeated heading re-enters it. */
export function sectionLines(lines: string[], prefix: string): string[] {
	const heading = `## ${prefix}`;
	const found: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (line.startsWith(heading)) {
			inSection = true;
			continue;
		}
		if (inSection && line.startsWith("## ")) break;
		if (inSection) found.push(line);
	}
	return found;
}

export async function sliceCommand(args: string[]): Promise<number> {
	if (args.length < 2) usageError("slice <spec> <N>");
	const [spec = "", number = ""] = args;
	needFile(spec);
	if (!/^\d+$/.test(number)) die(`slice number must be integer: ${number}`);
	const start = new RegExp(`^### Slice ${number}([^0-9]|$)`);
	const out: string[] = [];
	let section = "";
	let printed = false;
	let inSlice = false;
	records(await readText(spec)).forEach((line, index) => {
		if (line.startsWith("## ")) {
			section = line;
			printed = false;
			inSlice = false;
		} else if (start.test(line)) {
			if (!printed) {
				if (index > 0) out.push("");
				out.push(section, "");
				printed = true;
			}
			inSlice = true;
			out.push(line);
		} else if (/^### Slice [0-9]+/.test(line)) inSlice = false;
		else if (inSlice) out.push(line);
	});
	say(joinRecords(out));
	return 0;
}

export async function auditCommand(args: string[]): Promise<number> {
	const [spec] = args;
	if (spec === undefined) return usageError("audit <spec>");
	needFile(spec);
	const unchecked = new Map<string, number>();
	let total = 0;
	let checked = 0;
	let header = "";
	for (const line of records(await readText(spec))) {
		if (/^#{1,6} /.test(line)) header = line;
		if (/^\s*- \[ \]/.test(line)) {
			unchecked.set(header, (unchecked.get(header) ?? 0) + 1);
			total += 1;
		}
		if (/^\s*- \[[xX]\]/.test(line)) checked += 1;
	}
	if (total === 0) {
		say(`all checkboxes checked (${checked} total)\n`);
		return 0;
	}
	say(`unchecked: ${total} / ${total + checked}\n\n`);
	for (const [name, count] of unchecked)
		say(`  ${name} — ${count} unchecked\n`);
	return 1;
}

export async function prBodyCommand(args: string[]): Promise<number> {
	const [spec] = args;
	if (spec === undefined) return usageError("pr-body <spec>");
	needFile(spec);
	const lines = records(await readText(spec));
	say("## Summary\n\n");
	say(joinRecords(sectionLines(lines, "Summary")));
	say("\n## Test Plan\n\n");
	say(
		joinRecords(
			sectionLines(lines, "Acceptance").filter((line) =>
				/^\s*- \[[xX ]\]/.test(line),
			),
		),
	);
	say("\n## Issues Remediation\n\n");
	if (lines.some((line) => line.startsWith("## Issues Remediation")))
		say(joinRecords(sectionLines(lines, "Issues Remediation")));
	else say("_No issues._\n");
	return 0;
}

export function openIssueCount(lines: string[]): number {
	if (!lines.some((line) => line.startsWith("## Issues Remediation"))) return 0;
	return sectionLines(lines, "Issues Remediation").filter(
		(line) =>
			/^\| *[0-9]+ *\|/.test(line) && !/\| *(resolved|done) *\|/.test(line),
	).length;
}

const ISSUES_HEADER = "| id | slice | from | severity | status | description |";
const ISSUES_RULE = "|----|-------|------|----------|--------|-------------|";

function column(row: string, index: number): string {
	return (row.split("|")[index] ?? "").replace(/^ +| +$/g, "");
}

function listIssues(lines: string[], openOnly: boolean, slice: string): string {
	const out: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (line.startsWith("## Issues Remediation")) {
			inSection = true;
			out.push(line);
			continue;
		}
		if (inSection && line.startsWith("## ")) break;
		if (!inSection) continue;
		if (line.startsWith("|")) {
			if (/^\| *id *\|/.test(line) || /^\|[-: ]+\|/.test(line)) {
				out.push(line);
				continue;
			}
			if (slice !== "" && !awkEquals(column(line, 2), slice)) continue;
			if (openOnly && /resolved|done/.test(column(line, 5).toLowerCase()))
				continue;
			out.push(line);
			continue;
		}
		out.push(line);
	}
	return joinRecords(out);
}

function nextIssueId(lines: string[]): number {
	let max = 0;
	let inSection = false;
	for (const line of lines) {
		if (line.startsWith("## Issues Remediation")) {
			inSection = true;
			continue;
		}
		if (inSection && line.startsWith("## ")) break;
		if (inSection && /^\| *[0-9]+ *\|/.test(line))
			max = Math.max(max, awkNumber(column(line, 1)));
	}
	return max + 1;
}

function addIssueRow(text: string, row: string): string {
	if (
		!text.split("\n").some((line) => line.startsWith("## Issues Remediation"))
	)
		return `${text}\n## Issues Remediation\n\n${ISSUES_HEADER}\n${ISSUES_RULE}\n${row}\n`;
	const out: string[] = [];
	let inSection = false;
	let added = false;
	let haveHeader = false;
	const ensureTable = () => {
		if (haveHeader) return;
		out.push(ISSUES_HEADER, ISSUES_RULE);
		haveHeader = true;
	};
	for (const line of records(text)) {
		if (line.startsWith("## Issues Remediation")) {
			inSection = true;
			out.push(line);
			continue;
		}
		if (inSection && line.startsWith("## ")) {
			if (!added) {
				ensureTable();
				out.push(row);
				added = true;
			}
			inSection = false;
		}
		if (inSection && /^\| *id *\|/.test(line)) haveHeader = true;
		out.push(line);
	}
	if (inSection && !added) {
		ensureTable();
		out.push(row);
	}
	return joinRecords(out);
}

function resolveIssueRows(text: string, id: string, note: string): string {
	const out: string[] = [];
	let inSection = false;
	for (const line of records(text)) {
		if (line.startsWith("## Issues Remediation")) {
			inSection = true;
			out.push(line);
			continue;
		}
		if (inSection && line.startsWith("## ")) inSection = false;
		if (inSection && line.startsWith("|") && awkEquals(column(line, 1), id)) {
			let row = line.replace(
				/\| *(open|in[ _-]?progress|deferred) *\|/,
				() => "| resolved |",
			);
			if (note !== "") row = row.replace(/ *\|\s*$/, () => ` (${note}) |`);
			out.push(row);
			continue;
		}
		out.push(line);
	}
	return joinRecords(out);
}

interface IssueFlags {
	values: Record<string, string>;
	open: boolean;
}

function readIssueFlags(
	action: string,
	args: string[],
	valued: string[],
	boolean: string[],
): IssueFlags {
	const flags: IssueFlags = { values: {}, open: false };
	for (let i = 0; i < args.length; ) {
		const arg = args[i] as string;
		if (valued.includes(arg)) {
			flags.values[arg] = flagValue(args, i, arg);
			i += 2;
		} else if (boolean.includes(arg)) {
			flags.open = true;
			i += 1;
		} else die(`unknown issues ${action} flag: ${arg}`);
	}
	return flags;
}

export async function issuesCommand(args: string[]): Promise<number> {
	const [action, spec, ...rest] = args;
	if (action === undefined)
		return usageError("issues add|list|resolve <spec> [flags]");
	if (spec === undefined) return usageError(`issues ${action} <spec> [flags]`);
	needFile(spec);
	const text = await readText(spec);
	switch (action) {
		case "list": {
			const flags = readIssueFlags("list", rest, ["--slice"], ["--open"]);
			say(listIssues(records(text), flags.open, flags.values["--slice"] ?? ""));
			return 0;
		}
		case "add": {
			const { values } = readIssueFlags(
				"add",
				rest,
				["--slice", "--from", "--severity", "--desc"],
				[],
			);
			const slice = values["--slice"] ?? "";
			const from = values["--from"] ?? "";
			const description = values["--desc"] ?? "";
			if (slice === "" || from === "" || description === "")
				die("issues add requires --slice, --from, --desc");
			const severity = values["--severity"] || "med";
			const id = nextIssueId(records(text));
			const row = `| ${id} | ${slice} | ${from} | ${severity} | open | ${description} |`;
			replaceText(spec, addIssueRow(text, row));
			say(`added issue #${id}\n`);
			return 0;
		}
		case "resolve": {
			const { values } = readIssueFlags(
				"resolve",
				rest,
				["--id", "--note"],
				[],
			);
			const id = values["--id"] ?? "";
			if (id === "") die("issues resolve requires --id");
			replaceText(spec, resolveIssueRows(text, id, values["--note"] ?? ""));
			say(`resolved issue #${id}\n`);
			return 0;
		}
		default:
			return die(
				`issues: unknown action: ${action} (expected add|list|resolve)`,
			);
	}
}

const APPEND_SECTION_HELP = `usage: ${PROGRAM} append-section <spec> --section <name> <text>

Append <text> as a new line under the markdown section \`## <name>\` in
<spec>'s body. If the section heading is absent, it is created at end-
of-file with a blank-line separator. Multi-line <text> is permitted;
quote at the call site. The file is replaced atomically.

No deduplication: repeated calls with the same text append duplicate
lines (intentional — agents may log the same observation under different
contexts). No section-name whitelist (templates use "Agent Notes" and
"Slice Summaries"; other names accepted).

Exits: 0 ok / 2 usage or IO error.
`;

function appendToSection(text: string, section: string, line: string): string {
	const heading = `## ${section}`;
	const out: string[] = [];
	let pending = "";
	let inTarget = false;
	let found = false;
	const flush = () => {
		out.push(pending);
		pending = "";
	};
	for (const current of records(text)) {
		if (current === heading) {
			flush();
			out.push(`${current}\n`);
			inTarget = true;
			found = true;
		} else if (inTarget && current.startsWith("## ")) {
			out.push(`${line}\n`);
			flush();
			inTarget = false;
			out.push(`${current}\n`);
		} else if (inTarget && current === "") pending += "\n";
		else {
			if (inTarget) flush();
			out.push(`${current}\n`);
		}
	}
	if (inTarget) {
		out.push(`${line}\n`);
		flush();
	} else if (!found) out.push("\n", `${heading}\n`, "\n", `${line}\n`);
	return out.join("");
}

export async function appendSectionCommand(args: string[]): Promise<number> {
	let spec: string | undefined;
	let section = "";
	let text: string | undefined;
	for (let i = 0; i < args.length; ) {
		const arg = args[i] as string;
		if (arg === "-h" || arg === "--help") {
			say(APPEND_SECTION_HELP);
			return 0;
		}
		if (arg === "--section") {
			section = flagValue(args, i, arg);
			i += 2;
		} else if (arg.startsWith("-")) die(`unknown append-section flag: ${arg}`);
		else {
			if (spec === undefined) spec = arg;
			else if (text === undefined) text = arg;
			else die("append-section takes <spec> --section <name> <text>");
			i += 1;
		}
	}
	if (spec === undefined || section === "" || text === undefined)
		return usageError("append-section <spec> --section <name> <text>");
	needFile(spec);
	replaceText(spec, appendToSection(await readText(spec), section, text));
	say(`${spec}: appended to "${section}"\n`);
	return 0;
}
