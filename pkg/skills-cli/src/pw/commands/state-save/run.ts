import { writePrivate } from "../../core/files";
import { resolveOutput, timestampedName } from "../../core/response";
import type { DaemonHandler } from "../../core/spec";

const stateSave: DaemonHandler = async (ctx, args) => {
	const file = resolveOutput(
		ctx.outputDir,
		args.positionals[0] ?? timestampedName("storage-state", "json"),
	);
	const state = await ctx.context.storageState({ indexedDB: true });
	writePrivate(file, `${JSON.stringify(state, null, 2)}\n`);
	return {
		result: `- [Storage state](${file})`,
		code: `await page.context().storageState({ path: ${JSON.stringify(file)}, indexedDB: true });`,
	};
};

export default stateSave;
