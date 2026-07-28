import { resolve } from "node:path";
import {
	checkMailboxBoundaries,
	loadMailboxContractManifest,
	type MailboxContractManifest,
} from "./check-mailbox-boundaries";

export type MailboxGateCommand = Readonly<{
	name: "tests" | "boundaries" | "typecheck" | "chrome" | "firefox";
	args: readonly string[];
}>;

export type MailboxGateCommandResult = Readonly<{
	exitCode: number;
	stdout: string;
	stderr: string;
}>;

export type MailboxCoreGateDeps = Readonly<{
	repoRoot: string;
	extensionRoot: string;
	pinPath?: string;
	run(
		command: MailboxGateCommand,
		cwd: string,
	): Promise<MailboxGateCommandResult>;
	writeStdout(value: string): void;
	writeStderr(value: string): void;
	loadManifest(repoRoot: string): Promise<MailboxContractManifest>;
	checkBoundaries(
		repoRoot: string,
		options: Readonly<{ pinPath?: string }>,
	): Promise<MailboxContractManifest>;
}>;

export const MAILBOX_CORE_GATE_COMMANDS: readonly MailboxGateCommand[] =
	Object.freeze([
		{
			name: "tests",
			args: ["bun", "run", "test:mailbox-core"],
		},
		{
			name: "boundaries",
			args: [
				"bun",
				"scripts/check-mailbox-boundaries.ts",
				"--check",
			],
		},
		{
			name: "typecheck",
			args: ["bun", "run", "compile"],
		},
		{
			name: "chrome",
			args: ["bun", "run", "build"],
		},
		{
			name: "firefox",
			args: ["bun", "run", "build:firefox"],
		},
	]);

export function mailboxContractSuccessRecord(
	manifest: MailboxContractManifest,
): string {
	return JSON.stringify({
		contract: manifest.contract,
		hash: manifest.hash.digest,
		status: manifest.successRecord.status,
		version: manifest.version,
	});
}

export async function runMailboxCoreGate(
	deps: MailboxCoreGateDeps,
): Promise<void> {
	const manifest = await deps.loadManifest(deps.repoRoot);
	for (const command of MAILBOX_CORE_GATE_COMMANDS) {
		if (command.name === "boundaries") {
			await deps.checkBoundaries(deps.repoRoot, {
				...(deps.pinPath === undefined
					? {}
					: { pinPath: deps.pinPath }),
			});
			continue;
		}
		const result = await deps.run(command, deps.extensionRoot);
		if (result.stdout.length > 0) deps.writeStderr(result.stdout);
		if (result.stderr.length > 0) deps.writeStderr(result.stderr);
		if (result.exitCode !== 0) {
			throw new Error(
				`Mailbox core gate failed at ${command.name} (${result.exitCode})`,
			);
		}
	}
	deps.writeStdout(`${mailboxContractSuccessRecord(manifest)}\n`);
}

async function runCommand(
	command: MailboxGateCommand,
	cwd: string,
): Promise<MailboxGateCommandResult> {
	const child = Bun.spawn([...command.args], {
		cwd,
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const pinIndex = args.indexOf("--pin");
	const pinPath = pinIndex < 0 ? undefined : args[pinIndex + 1];
	if (
		args.some((arg, index) =>
			index === pinIndex + 1 ? false : arg !== "--pin",
		) ||
		(pinIndex >= 0 && pinPath === undefined)
	) {
		throw new Error("Usage: mailbox-core-gate.ts [--pin path]");
	}
	const repoRoot = resolve(import.meta.dir, "../../..");
	await runMailboxCoreGate({
		repoRoot,
		extensionRoot: resolve(repoRoot, "pkg/extension"),
		...(pinPath === undefined ? {} : { pinPath }),
		run: runCommand,
		writeStdout: (value) => process.stdout.write(value),
		writeStderr: (value) => process.stderr.write(value),
		loadManifest: loadMailboxContractManifest,
		checkBoundaries: checkMailboxBoundaries,
	});
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Mailbox core gate failed"}\n`,
		);
		process.exitCode = 1;
	});
}
