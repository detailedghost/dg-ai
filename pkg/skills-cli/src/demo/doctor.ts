import {
	allowRuleCheck,
	extOnlyChecks,
	skillFilesCheck,
} from "../doctor/checks";
import { type DoctorCheck, ok, warn } from "../doctor/types";
import { browserStatusCheck } from "../pw/doctor";

const ffmpegCheck: DoctorCheck = {
	id: "ffmpeg",
	run(ctx) {
		const find = (name: string) => Bun.which(name, { PATH: ctx.env.PATH ?? "" });
		const missing = ["ffmpeg", "ffprobe"].filter((name) => !find(name));
		if (missing.length === 0) return ok("ffmpeg: found, demos encode to MP4");
		return warn(
			`${missing.join(" and ")} not found; demos stay raw webm files`,
			"install ffmpeg (for example: sudo apt install ffmpeg, or brew install ffmpeg)",
		);
	},
};

export const demoChecks: DoctorCheck[] = [
	skillFilesCheck(["demo"]),
	browserStatusCheck,
	ffmpegCheck,
	...extOnlyChecks,
	allowRuleCheck("demo"),
];
