import { stringFlag, UsageError } from "../../core/args";
import type { DaemonHandler } from "../../core/spec";

const videoChapter: DaemonHandler = async (ctx, args) => {
	const title = args.positionals[0] as string;
	const description = stringFlag(args, "description");
	const duration = stringFlag(args, "duration");
	if (
		duration !== undefined &&
		(!/^\d+$/.test(duration) || !Number.isSafeInteger(Number(duration)))
	) {
		throw new UsageError(
			`Invalid --duration '${duration}': use milliseconds as an integer`,
		);
	}
	const options = {
		...(description === undefined ? {} : { description }),
		...(duration === undefined ? {} : { duration: Number(duration) }),
	};
	const video = ctx.state.video;
	if (!video)
		throw new Error("No video recording in progress. Run: pw video-start");
	await video.page.screencast.showChapter(title, options);
	return {
		code: `await page.screencast.showChapter(${JSON.stringify(title)}, ${JSON.stringify(options)});`,
	};
};

export default videoChapter;
