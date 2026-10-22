import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { writeStdout } from "@dg/common/node";
import type { CommandSpec } from "../utils/legacy-command";
import {
	AmbiguousQueryError,
	appendSection,
	defaultCheckpointFile,
	listSections,
	readCheckpointFile,
	removeSection,
	replaceSection,
	updateCheckpointFile,
	validateSection,
} from "./checkpoint";
import { INDEX_FILE, layoutJot, titleOf } from "./layout";
import {
	ensureRepoIgnore,
	listEntries,
	noteWriteDir,
	type JotKind,
	resolveJot,
	saveWriteDir,
	writeNewJot,
} from "./store";

const DEFAULT_LS_LIMIT = 10;

function flag(args: string[], short: string, long: string): boolean {
	return args.includes(short) || args.includes(long);
}

function fileOption(args: string[]): { file: string; rest: string[] } {
	const at = args.indexOf("--file");
	if (at === -1) return { file: defaultCheckpointFile(), rest: args };
	const file = args[at + 1];
	if (!file) throw new Error("--file needs a path");
	return { file, rest: args.filter((_, i) => i !== at && i !== at + 1) };
}

function lsKind(args: string[]): JotKind | null {
	if (flag(args, "-s", "--save")) return "save";
	if (flag(args, "-n", "--note")) return "note";
	return null;
}

function kickRow(s: { id: string; summary: string }): string {
	return `${s.id}\t${s.summary}\n`;
}

function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

export const jotSpec: CommandSpec = {
	name: "jot",
	description:
		"Agent notes (scratch) and session saves (durable), capped at 2 KB per file.",
	subcommands: {
		add: {
			description:
				"Write stdin as a jot; -s/--save for a durable handoff. Prints the path.",
			async run(args) {
				const save = flag(args, "-s", "--save");
				const layout = layoutJot(await Bun.stdin.text());
				const dir = save ? saveWriteDir() : noteWriteDir();
				if (save) ensureRepoIgnore(dir);
				await writeStdout(`${writeNewJot(dir, layout)}\n`);
			},
		},

		ls: {
			description:
				"Index, newest first: kind, age, name, title. -s saves, -n notes, --all no limit.",
			async run(args) {
				const only = lsKind(args);
				const now = Date.now();
				const rows = listEntries().filter((e) => !only || e.kind === only);
				const shown = args.includes("--all")
					? rows
					: rows.slice(0, DEFAULT_LS_LIMIT);
				let out = "";
				for (const e of shown) {
					let text: string;
					try {
						text = readFileSync(e.file, "utf8");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw error;
					}
					const title = titleOf(text);
					out += `${e.kind}\t${formatAge(now - e.mtimeMs)}\t${e.name}\t${title}\n`;
				}
				if (out) await writeStdout(out);
				if (shown.length < rows.length)
					process.stderr.write(
						`${rows.length - shown.length} more; use --all\n`,
					);
			},
		},

		read: {
			description:
				"Print a jot. A split jot prints its index; <name>/<NN> prints one part.",
			args: ["name[/NN]"],
			async run(args) {
				const ref = args[0];
				if (!ref) throw new Error("missing name; run dg-skills jot ls");
				const [base = ref, part] =
					ref.includes("/") && !path.isAbsolute(ref)
						? ref.split("/", 2)
						: [ref, undefined];
				const jot = resolveJot(base);
				if (!jot.isFolder) {
					if (part)
						throw new Error(`${base} is not split; read it without /${part}`);
					await writeStdout(readFileSync(jot.target, "utf8"));
					return;
				}
				if (!part) {
					await writeStdout(
						readFileSync(path.join(jot.target, INDEX_FILE), "utf8"),
					);
					return;
				}
				const file = readdirSync(jot.target).find(
					(f) => f !== INDEX_FILE && f.startsWith(`${part.padStart(2, "0")}-`),
				);
				if (!file)
					throw new Error(
						`no part ${part} in ${base}; read ${base} for the index`,
					);
				await writeStdout(readFileSync(path.join(jot.target, file), "utf8"));
			},
		},

		kind: {
			description: "Print note or save for a jot name or path.",
			args: ["path|name"],
			async run(args) {
				if (!args[0]) throw new Error("missing path or name");
				await writeStdout(`${resolveJot(args[0]).kind}\n`);
			},
		},

		kick: {
			description:
				"Append one checkpoint section from stdin to the common file; --replace updates the same id.",
			async run(args) {
				const { file, rest } = fileOption(args);
				const section = validateSection(await Bun.stdin.text());
				const write = rest.includes("--replace")
					? replaceSection
					: appendSection;
				await updateCheckpointFile(file, (content) => write(content, section));
				await writeStdout(`${section.id}\n`);
			},
		},

		"kick-list": {
			description: "List kicked sections: id, summary.",
			async run(args) {
				const { file } = fileOption(args);
				const out = listSections(readCheckpointFile(file))
					.map(kickRow)
					.join("");
				if (out) await writeStdout(out);
			},
		},

		"kick-take": {
			description:
				"Print the one matching section, then remove it from the file. Several matches remove nothing.",
			args: ["id|text"],
			async run(args) {
				const { file, rest } = fileOption(args);
				const query = rest.find((a) => !a.startsWith("--"));
				if (query === undefined)
					throw new Error("missing id or text; run kick-list");
				if (!existsSync(file))
					throw new Error(`no checkpoint matches "${query}"; run kick-list`);
				let kept = false;
				try {
					await updateCheckpointFile(file, async (content) => {
						const {
							removed,
							content: next,
							leftover,
						} = removeSection(content, query);
						await writeStdout(removed.text);
						kept = leftover === "preamble";
						return leftover === "none" ? null : next;
					});
					if (kept)
						process.stderr.write(
							`kept ${file}: it has text besides the CLI header\n`,
						);
				} catch (error) {
					if (!(error instanceof AmbiguousQueryError)) throw error;
					await writeStdout(error.hits.map(kickRow).join(""));
					process.stderr.write(`${error.message}\n`);
					return 1;
				}
			},
		},

		done: {
			description: "Remove a jot (file or split folder).",
			args: ["name"],
			async run(args) {
				if (!args[0]) throw new Error("missing name");
				const jot = resolveJot(args[0]);
				rmSync(jot.target, { recursive: true, force: true });
				await writeStdout(`removed ${jot.target}\n`);
			},
		},
	},
};
