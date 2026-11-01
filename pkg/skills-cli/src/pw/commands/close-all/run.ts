import { list, reapStale, stopSession } from "../../core/registry";
import type { ClientHandler } from "../../core/spec";

const closeAll: ClientHandler = async (_args, env) => {
	await reapStale();
	const records = list();
	await Promise.all(records.map((record) => stopSession(record)));
	env.out(
		records.length === 0
			? "### No open browsers."
			: records.map((r) => `### Browser \`${r.key}\` closed.`).join("\n"),
	);
	return 0;
};

export default closeAll;
