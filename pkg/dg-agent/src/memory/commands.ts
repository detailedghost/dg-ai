import {
	CHAT_MAX_MESSAGE_BODY_BYTES,
	DgCliError,
	parseNonNegativeInteger,
} from "@dg/common";
import {
	readCappedStdin,
	readSessionFiles,
	resolveDgPaths,
	soleSessionForCwd,
	writeStdout,
} from "@dg/common/node";
import type { Command } from "commander";
import { selectedSession } from "../commands";
import { MEMORY_MAX_PAGE_SIZE, type MemoryRecord, MemoryStore } from "./store";

type ScopeOptions = { identity?: string; workset?: string };

type SearchOptions = ScopeOptions & {
	limit?: string;
	offset?: string;
	full?: boolean;
};

function resolveIdentity(
	sessionsDir: string,
	options: ScopeOptions,
	command: Command,
): string {
	if (options.identity) return options.identity;
	const sessionId = selectedSession(command);
	if (sessionId) {
		const record = readSessionFiles(sessionsDir).find(
			(candidate) => candidate.sessionId === sessionId,
		);
		if (!record) {
			throw new DgCliError(`no usable session file for ${sessionId}`);
		}
		return record.agentIdentity;
	}
	return soleSessionForCwd(sessionsDir).agentIdentity;
}

function requireTitle(value: string): string {
	const title = value.trim();
	if (title === "") throw new DgCliError("the title cannot be blank");
	return title;
}

function requireBody(value: string): string {
	if (value.trim() === "") throw new DgCliError("the body cannot be blank");
	return value.trimEnd();
}

async function readBody(argument: string | undefined): Promise<string> {
	if (argument !== undefined) return requireBody(argument);
	if (process.stdin.isTTY) {
		throw new DgCliError("pass a body argument or pipe one on stdin");
	}
	const piped = await readCappedStdin(CHAT_MAX_MESSAGE_BODY_BYTES);
	if (piped === undefined) {
		throw new DgCliError(
			`the piped body exceeds CHAT_MAX_MESSAGE_BODY_BYTES (${CHAT_MAX_MESSAGE_BODY_BYTES})`,
		);
	}
	return requireBody(piped);
}

function summaryLine(record: MemoryRecord): string {
	const scope = record.workset ? ` [${record.workset}]` : "";
	return `${record.id}  ${record.updatedAt.slice(0, 10)}${scope}  ${record.title}`;
}

function plainText(record: MemoryRecord): string {
	return `${record.title}\n\n${record.body}\n`;
}

async function withStore<T>(run: (store: MemoryStore) => T): Promise<T> {
	const store = MemoryStore.open(resolveDgPaths());
	try {
		return run(store);
	} finally {
		store.close();
	}
}

export function registerMemoryCommands(program: Command): void {
	const memory = program
		.command("memory")
		.description("read and write this agent's own long-term memory");

	memory
		.command("write")
		.description(
			"record one memory, replacing what this agent knew by that title",
		)
		.argument("<title>", "what the memory is about")
		.argument("[body]", "the memory itself (otherwise read from stdin)")
		.option("--identity <name>", "record under another agent identity")
		.option("--workset <label>", "scope the memory to one workset")
		.option("--kind <kind>", "what kind of memory this is")
		.action(
			async (
				title: string,
				body: string | undefined,
				options: ScopeOptions & { kind?: string },
				command: Command,
			) => {
				const paths = resolveDgPaths();
				const agentIdentity = resolveIdentity(
					paths.sessionsDir,
					options,
					command,
				);
				const text = await readBody(body);
				const record = await withStore((store) =>
					store.write({
						agentIdentity,
						title: requireTitle(title),
						body: text,
						...(options.kind ? { kind: options.kind } : {}),
						...(options.workset ? { workset: options.workset } : {}),
					}),
				);
				await writeStdout(`${record.id}\n`);
			},
		);

	memory
		.command("search")
		.description("find this agent's memories, most relevant first")
		.argument("[query]", "search terms (otherwise list the most recent)")
		.option("--identity <name>", "search another agent identity")
		.option("--workset <label>", "restrict the search to one workset")
		.option("--limit <n>", `hits to return (at most ${MEMORY_MAX_PAGE_SIZE})`)
		.option("--offset <n>", "hits to skip")
		.option("--full", "print the whole record as JSON instead of one line")
		.action(
			async (
				query: string | undefined,
				options: SearchOptions,
				command: Command,
			) => {
				const paths = resolveDgPaths();
				const agentIdentity = resolveIdentity(
					paths.sessionsDir,
					options,
					command,
				);
				const hits = await withStore((store) =>
					store.search({
						agentIdentity,
						...(query !== undefined ? { query } : {}),
						...(options.workset ? { workset: options.workset } : {}),
						...(options.limit !== undefined
							? { limit: parseNonNegativeInteger("--limit", options.limit) }
							: {}),
						...(options.offset !== undefined
							? { offset: parseNonNegativeInteger("--offset", options.offset) }
							: {}),
					}),
				);
				const render = options.full
					? (record: MemoryRecord) => JSON.stringify(record)
					: summaryLine;
				for (const hit of hits) await writeStdout(`${render(hit)}\n`);
			},
		);

	memory
		.command("read")
		.description("print one memory")
		.argument("<id>", "memory id")
		.option("--full", "print the whole record as JSON instead of the text")
		.action(async (id: string, options: { full?: boolean }) => {
			const record = await withStore((store) => store.read(id));
			if (!record) throw new DgCliError(`no memory with id ${id}`);
			await writeStdout(
				options.full ? `${JSON.stringify(record)}\n` : plainText(record),
			);
		});

	memory
		.command("forget")
		.description("remove one memory")
		.argument("<id>", "memory id")
		.action(async (id: string) => {
			const forgotten = await withStore((store) => store.forget(id));
			if (!forgotten) throw new DgCliError(`no memory with id ${id}`);
		});
}
