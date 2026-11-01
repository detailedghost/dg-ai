import path from "node:path";
import { scratchRoot, stateRoot } from "@dg/common/node";
import {
	allowRuleCheck,
	noAllowRuleCheck,
	skillFilesCheck,
} from "../doctor/checks";
import { rootCheck } from "../doctor/shared";
import { type DoctorCheck, ok, warn } from "../doctor/types";
import { type SystemChannel, systemBrowserPresent } from "./core/browser";
import { downloadedChromium } from "./core/downloaded";

const SYSTEM_CHANNELS: SystemChannel[] = ["chrome", "msedge"];

export function createBrowserCheck(
	system: (channel: SystemChannel) => boolean,
): DoctorCheck {
	return {
		id: "browser",
		run(ctx) {
			const channel = SYSTEM_CHANNELS.find((candidate) => system(candidate));
			if (channel) return ok(`browser: ${channel} (system)`);
			const downloaded = downloadedChromium(
				path.join(ctx.paths.stateDir, "browsers"),
			);
			if (downloaded)
				return ok(`browser: chromium ${downloaded.version} (downloaded)`);
			return warn(
				"browser: none found, pw cannot open a page",
				"dg-skills pw install-browser",
			);
		},
	};
}

export const pwChecks: DoctorCheck[] = [
	skillFilesCheck(["pw"]),
	createBrowserCheck(systemBrowserPresent),
	rootCheck("scratch-root", "scratch", ({ env }) => scratchRoot(env)),
	rootCheck("state-root", "state", ({ env, home }) => stateRoot(env, home)),
	allowRuleCheck("pw"),
];

export const pwCodeChecks: DoctorCheck[] = [
	skillFilesCheck(["pw"]),
	noAllowRuleCheck("pw-code"),
];
