import type { SessionRecord } from "./registry";
import { call } from "./socket";
import type { ClientEnv } from "./spec";
import { type StorageState, statePathFor } from "./states";

export type RestoreTarget = Pick<SessionRecord, "name" | "scratch" | "socketPath">;

export function restoreMessage(target: RestoreTarget, name: string, state: StorageState): string {
	const cookies = state.cookies?.length ?? 0;
	const origins = (state.origins ?? []).filter((stored) => (stored.localStorage?.length ?? 0) > 0).length;
	const hasIndexedDb = (state.origins ?? []).some((stored) => (stored.indexedDB?.length ?? 0) > 0);
	const base = `Loaded ${cookies} cookies, ${origins} origins into session '${target.name}'.`;
	if (!hasIndexedDb) return base;
	return target.scratch
		? `${base} IndexedDB was not restored. Start with: pw open --scratch --from=${name}`
		: `${base} IndexedDB restores only into --scratch sessions.`;
}

export async function restoreState(
	target: RestoreTarget,
	name: string,
	state: StorageState,
	env: ClientEnv,
): Promise<number> {
	const response = await call(target, {
		id: "state-load",
		method: "run",
		params: {
			argv: ["state-load", statePathFor(name)],
			cwd: env.cwd,
			raw: true,
		},
	});
	if ("error" in response) {
		env.err(response.error);
		return 1;
	}
	if (response.result.exitCode !== 0) {
		env.err(response.result.text);
		return 1;
	}
	env.out(restoreMessage(target, name, state));
	return 0;
}
