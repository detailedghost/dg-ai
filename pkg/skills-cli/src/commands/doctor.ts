import type { Command } from "commander";

export function registerDoctor(program: Command): void {
	program
		.command("doctor")
		.description(
			"check that each dg-skills item has the tools, credentials and settings it needs; on a terminal, browse the results and apply a fix after a yes",
		)
		.argument("[item...]", "items to check; all items when omitted")
		.option("--json", "print the report as JSON")
		.option("--plain", "print the text report, even on a terminal")
		.action(async (items: string[], opts: { json?: boolean; plain?: boolean }) => {
			const [{ DOCTOR_REGISTRY }, { doctorExitCode, formatReport, runDoctor, unknownItems }] =
				await Promise.all([import("../doctor/registry"), import("../doctor/runner")]);
			const unknown = unknownItems(items, DOCTOR_REGISTRY);
			if (unknown.length > 0) {
				process.stderr.write(
					`dg-skills doctor: unknown item ${unknown.join(", ")}. Items: ${Object.keys(DOCTOR_REGISTRY).join(", ")}\n`,
				);
				process.exitCode = 2;
				return;
			}
			const check = () => runDoctor(items, DOCTOR_REGISTRY);
			let report = await check();
			if (!opts.json && !opts.plain && process.stdin.isTTY && process.stdout.isTTY) {
				const { runTui, terminalDeps } = await import("../doctor/tui");
				const deps = terminalDeps(check);
				try {
					report = await runTui(report, deps);
				} finally {
					deps.close();
				}
				process.exitCode = doctorExitCode(report);
				return;
			}
			process.stdout.write(
				opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report),
			);
			process.exitCode = doctorExitCode(report);
		});
}
