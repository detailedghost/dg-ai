import {
	closeFailure,
	list,
	reapStale,
	stopSession,
} from "../../core/registry";
import type { ClientHandler } from "../../core/spec";

const closeAll: ClientHandler = async (_args, env) => {
	await reapStale();
	const records = list();
	const outcomes = await Promise.all(
		records.map((record) => stopSession(record)),
	);
	const closed = records.filter((_, index) => outcomes[index]);
	const failed = records.filter((_, index) => !outcomes[index]);
	env.out(
		records.length === 0
			? "### No open browsers."
			: closed.map((r) => `### Browser \`${r.key}\` closed.`).join("\n"),
	);
	for (const record of failed) env.err(closeFailure(record));
	return failed.length === 0 ? 0 : 1;
};

export default closeAll;
