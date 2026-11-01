import {
	closeFailure,
	reapStale,
	resolve,
	stopSession,
} from "../../core/registry";
import type { ClientHandler } from "../../core/spec";

const close: ClientHandler = async (args, env) => {
	const record = resolve(args.session);
	if (!record) {
		await reapStale();
		env.err(`Browser '${args.session}' is not open. Run: pw open`);
		return 1;
	}
	if (!(await stopSession(record))) {
		env.err(closeFailure(record));
		return 1;
	}
	env.out(`### Browser \`${record.name}\` closed.`);
	return 0;
};

export default close;
