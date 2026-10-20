import { bgSpec } from "../bg";
import { defineCommand } from "../utils/legacy-command";

export { readPid, terminateGroup } from "../bg";

/** Keep `proxy background <verb>` working by sending it through the public bg dispatcher. */
export async function main(argv: string[]): Promise<void | number> {
	await defineCommand(bgSpec).run(argv);
}
