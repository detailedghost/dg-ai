import { existsSync } from "node:fs";
import { signalCliInstallHint } from "@dg/ssms";
import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import { whichBinary } from "../doctor/probes";
import { ok, warn, type DoctorCheck } from "../doctor/types";

export const ssmsChecks: DoctorCheck[] = [
	skillFilesCheck(["google-sms-cleanup"]),
	allowRuleCheck("ssms"),
	{
		id: "signal-cli",
		run(ctx) {
			const override = ctx.env.DG_SIGNAL_CLI;
			if (override) {
				if (!existsSync(override)) return warn(signalCliInstallHint(), "sudo pacman -S signal-cli");
				return ok("signal-cli found from DG_SIGNAL_CLI");
			}
			const found = whichBinary("signal-cli", ctx.env);
			if (found) return ok("signal-cli is on PATH");
			return warn(signalCliInstallHint(), "sudo pacman -S signal-cli");
		},
	},
];
