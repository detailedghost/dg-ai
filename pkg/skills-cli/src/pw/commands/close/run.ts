import { reapStale, resolve, stopSession } from "../../core/registry";
import type { ClientHandler } from "../../core/spec";

const close: ClientHandler = async (args, env) => {
	const record = resolve(args.session);
	if (!record) {
		await reapStale();
		env.err(`Browser '${args.session}' is not open. Run: pw open`);
		return 1;
	}
	await stopSession(record);
	env.out(`### Browser \`${record.name}\` closed.`);
	return 0;
};

export default close;
