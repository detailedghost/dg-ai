import { realpathSync } from "node:fs";
import {
	readSessionFiles,
	resolveDgPaths,
	selectSoleSession,
	type SessionTokenRecord,
	sessionsForCwd,
} from "@dg/common/node";
import { programCommand } from "@dg/common/node/program";

export interface SessionDeps {
	env: Record<string, string | undefined>;
	cwd(): string;
	listSessions(): SessionTokenRecord[];
	spawnAgentStart(): Promise<string>;
}

async function spawnAgentStart(): Promise<string> {
	const child = Bun.spawn(programCommand("dg-agent", ["start", "--print-session-id"]), {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(`dg-agent start failed (exit ${code}): ${stderr.trim()}`);
	return stdout;
}

const defaultSessionDeps: SessionDeps = {
	env: process.env,
	cwd: () => realpathSync(process.cwd()),
	listSessions: () => readSessionFiles(resolveDgPaths().sessionsDir),
	spawnAgentStart,
};

export async function ensureCwdSession(
	explicit: string | undefined,
	overrides: Partial<SessionDeps> = {},
): Promise<string> {
	const deps = { ...defaultSessionDeps, ...overrides };
	const requested = explicit || deps.env.DG_SESSION_ID;
	if (requested) return requested;
	const records = deps.listSessions();
	const cwd = deps.cwd();
	const matches = sessionsForCwd(records, cwd);
	if (matches.length === 0) {
		const id = (await deps.spawnAgentStart()).trim();
		if (!id) throw new Error("dg-agent start printed no session id");
		return id;
	}
	return selectSoleSession(matches, cwd).sessionId;
}
