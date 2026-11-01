import path from "node:path";
import { scratchRoot, stateRoot } from "@dg/common/node";
import {
	allowRuleCheck,
	noAllowRuleCheck,
	skillFilesCheck,
} from "../doctor/checks";
import { rootCheck } from "../doctor/shared";
import { type DoctorCheck, ok, warn } from "../doctor/types";
import { isWSL } from "@dg/common/node";
import { type SystemChannel, systemBrowserPresent } from "./core/browser";
import { exePath } from "./core/windows";
import { downloadedChromium } from "./core/downloaded";

const SYSTEM_CHANNELS: SystemChannel[] = ["chrome", "msedge"];

export interface BrowserPresentDeps {
	isWSL(): boolean;
	system(channel: SystemChannel): boolean;
	windows(channel: SystemChannel): boolean;
}

const BROWSER_DEPS: BrowserPresentDeps = {
	isWSL,
	system: systemBrowserPresent,
	windows: (channel) => exePath(channel) !== null,
};

/** Matches pw open: on WSL a Windows Chrome or Edge counts as present. */
export function browserPresent(
	channel: SystemChannel,
	deps: BrowserPresentDeps = BROWSER_DEPS,
): boolean {
	return deps.system(channel) || (deps.isWSL() && deps.windows(channel));
}

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
	createBrowserCheck((channel) => browserPresent(channel)),
	rootCheck("scratch-root", "scratch", ({ env }) => scratchRoot(env)),
	rootCheck("state-root", "state", ({ env, home }) => stateRoot(env, home)),
	allowRuleCheck("pw"),
];

export const pwCodeChecks: DoctorCheck[] = [
	skillFilesCheck(["pw"]),
	noAllowRuleCheck("pw-code"),
];
