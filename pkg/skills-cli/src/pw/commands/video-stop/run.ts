import { restrictFile } from "../../core/files";
import type { DaemonHandler } from "../../core/spec";

const videoStop: DaemonHandler = async (ctx) => {
	const video = ctx.state.video;
	if (!video) throw new Error("No video recording in progress. Run: pw video-start");
	ctx.state.video = undefined;
	await video.page.screencast.stop();
	restrictFile(video.file);
	return {
		result: `- [Video](${video.file})`,
		code: "await page.screencast.stop();",
	};
};

export default videoStop;
