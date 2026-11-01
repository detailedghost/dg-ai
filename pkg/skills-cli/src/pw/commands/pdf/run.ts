import { stringFlag } from "../../core/args";
import { publishPrivate } from "../../core/files";
import { resolveOutput, timestampedName } from "../../core/response";
import type { DaemonHandler } from "../../core/spec";

const pdf: DaemonHandler = async (ctx, args) => {
	const file = resolveOutput(
		ctx.outputDir,
		stringFlag(args, "filename") ?? timestampedName("page", "pdf"),
	);
	const page = ctx.page();
	await publishPrivate(file, (staging) => page.pdf({ path: staging }));
	return {
		result: `- [Page as PDF](${file})`,
		code: `await page.pdf({ path: ${JSON.stringify(file)} });`,
	};
};

export default pdf;
