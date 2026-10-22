import { existsSync } from "node:fs";
import { allowRuleCheck, pairingCheck, skillFilesCheck } from "../doctor/checks";
import { hasAllowRule, readAllowRules, whichBinary } from "../doctor/probes";
import { type CheckResult, type DoctorCheck, fail, ok, warn } from "../doctor/types";

const SYSTEM_BROWSERS = ["google-chrome-stable", "google-chrome", "microsoft-edge", "chromium-browser", "chromium"];

const browserCheck: DoctorCheck = {
	id: "browser",
	async run(ctx): Promise<CheckResult> {
		const system = SYSTEM_BROWSERS.find((name) => whichBinary(name, ctx.env));
		if (system) return ok(`${system} is on PATH for pw's default --browser=chrome`);
		const { chromium } = await import("playwright-core");
		const bundled = chromium.executablePath();
		if (existsSync(bundled)) return ok(`Playwright-managed Chromium is installed at ${bundled}`);
		return fail(
			"no Chrome-family browser on PATH and the Playwright-managed Chromium is not installed",
			"bunx playwright-core install chromium",
		);
	},
};

export const pwChecks: DoctorCheck[] = [skillFilesCheck(["pw"]), browserCheck, pairingCheck, allowRuleCheck("pw")];

/** pw-code stays a per-call approval; unlike other commands, an existing allow rule is the problem, not the fix. */
const noAllowRuleCheck: DoctorCheck = {
	id: "allow-rule",
	run(ctx) {
		const allowed = readAllowRules(ctx.home);
		if ("error" in allowed) return warn(`cannot read ~/.claude/settings.json: ${allowed.error}`, "jq . ~/.claude/settings.json");
		if (!hasAllowRule(allowed.rules, "pw-code")) return ok("no allow rule covers pw-code, so every run-code call still asks first");
		return fail(
			"an allow rule covers pw-code, so it can run arbitrary code without asking; remove it from ~/.claude/settings.json",
			"pw-code stays a separately approved action; do not add it to allowed-tools or to an allow rule",
		);
	},
};

export const pwCodeChecks: DoctorCheck[] = [browserCheck, noAllowRuleCheck];
