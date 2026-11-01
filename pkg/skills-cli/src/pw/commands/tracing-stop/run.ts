import { publishPrivate } from "../../core/files";
import { resolveOutput, timestampedName } from "../../core/response";
import type { DaemonHandler } from "../../core/spec";

const tracingStop: DaemonHandler = async (ctx) => {
	if (!ctx.state.tracing)
		throw new Error("Tracing is not started. Run: pw tracing-start");
	const file = resolveOutput(ctx.outputDir, timestampedName("trace", "zip"));
	await publishPrivate(file, (staging) =>
		ctx.context.tracing.stop({ path: staging }),
	);
	ctx.state.tracing = false;
	return {
		result: `- [Trace](${file})`,
		code: `await page.context().tracing.stop({ path: ${JSON.stringify(file)} });`,
	};
};

export default tracingStop;
