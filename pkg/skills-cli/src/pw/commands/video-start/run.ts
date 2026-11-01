import { stringFlag, UsageError } from "../../core/args";
import { rmSync } from "node:fs";
import path from "node:path";
import { stagingPathFor } from "../../core/files";
import { resolveOutput, timestampedName } from "../../core/response";
import type { DaemonHandler } from "../../core/spec";

export function parseSize(
	value: string | undefined,
): { width: number; height: number } | undefined {
	if (value === undefined) return undefined;
	const match = /^(\d+)x(\d+)$/.exec(value);
	if (!match || Number(match[1]) === 0 || Number(match[2]) === 0) {
		throw new UsageError(
			`Invalid --size '${value}': use WIDTHxHEIGHT, such as 800x600`,
		);
	}
	return { width: Number(match[1]), height: Number(match[2]) };
}

const videoStart: DaemonHandler = async (ctx, args) => {
	if (ctx.state.video)
		throw new Error("A video is already recording. Run: pw video-stop");
	const size = parseSize(stringFlag(args, "size"));
	const file = resolveOutput(
		ctx.outputDir,
		args.positionals[0] ?? timestampedName("video", "webm"),
	);
	const recording = stagingPathFor(file);
	try {
		const page = ctx.page();
		await page.screencast.start({ path: recording, ...(size ? { size } : {}) });
		ctx.state.video = { page, file, recording };
	} catch (error) {
		rmSync(path.dirname(recording), { recursive: true, force: true });
		throw error;
	}
	return {
		result: `Video recording started: ${file}`,
		code: `await page.screencast.start(${JSON.stringify({ path: file, ...(size ? { size } : {}) })});`,
	};
};

export default videoStart;
