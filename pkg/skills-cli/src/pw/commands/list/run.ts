import { list } from "../../core/registry";
import type { ClientHandler } from "../../core/spec";

const listSessions: ClientHandler = async (_args, env) => {
	const records = list();
	if (records.length === 0) {
		env.out("### Browsers\n(none open)");
		return 0;
	}
	const lines = ["### Browsers"];
	for (const record of records) {
		lines.push(
			`- ${record.key}:`,
			"  - status: open",
			`  - cwd: ${record.cwd}`,
			`  - browser: ${record.browser}`,
			`  - profile: ${record.profileDir ?? "<in-memory>"}`,
			`  - pid: ${record.pid}`,
		);
		if (record.mode === "cdp") lines.push("  - mode: cdp", `  - cdp: ${record.cdpUrl}`);
	}
	env.out(lines.join("\n"));
	return 0;
};

export default listSessions;
