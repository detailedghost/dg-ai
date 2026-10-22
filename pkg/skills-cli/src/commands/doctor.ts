import type { Command } from "commander";
import { DOCTOR_REGISTRY } from "../doctor/registry";
import {
	doctorExitCode,
	formatReport,
	runDoctor,
	unknownItems,
} from "../doctor/runner";

export function registerDoctor(program: Command): void {
	program
		.command("doctor")
		.description(
			"check that each dg-skills item has the tools, credentials and settings it needs (read-only)",
		)
		.argument("[item...]", "items to check; all items when omitted")
		.option("--json", "print the report as JSON")
		.action(async (items: string[], opts: { json?: boolean }) => {
			const unknown = unknownItems(items, DOCTOR_REGISTRY);
			if (unknown.length > 0) {
				process.stderr.write(
					`dg-skills doctor: unknown item ${unknown.join(", ")}. Items: ${Object.keys(DOCTOR_REGISTRY).join(", ")}\n`,
				);
				process.exitCode = 2;
				return;
			}
			const report = await runDoctor(items, DOCTOR_REGISTRY);
			process.stdout.write(
				opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report),
			);
			process.exitCode = doctorExitCode(report);
		});
}
