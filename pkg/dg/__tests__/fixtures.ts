import { spyOn } from "bun:test";
import { type ProgramName, programName, setProgramName } from "@dg/common/node/program";
import { selfCommand } from "@dg/common/node/self-command";
import { main, type MountName, type Mounts } from "../src/main";

export const MOUNT_NAMES: readonly MountName[] = ["dg-daemon", "dg-skills", "dg-agent"];

export interface MountCall {
	program: MountName;
	argv: string[];
	mountedAtCall: ProgramName | undefined;
	selfArgv: string[];
}

export interface FakeMounts {
	mounts: Mounts;
	calls: MountCall[];
	loads: MountName[];
}

export function fakeMounts(exitCodes: Partial<Record<MountName, number>> = {}): FakeMounts {
	const calls: MountCall[] = [];
	const loads: MountName[] = [];
	const entries = MOUNT_NAMES.map((program) => {
		const loader = async () => {
			loads.push(program);
			return {
				async main(argv: string[]): Promise<number> {
					calls.push({ program, argv, mountedAtCall: programName(), selfArgv: selfCommand(["x"]) });
					return exitCodes[program] ?? 0;
				},
			};
		};
		return [program, loader] as const;
	});
	return { mounts: Object.fromEntries(entries) as Mounts, calls, loads };
}

export interface DgRun extends FakeMounts {
	code: number;
	stdout: string;
	stderr: string;
}

export async function runDg(argv: string[], exitCodes: Partial<Record<MountName, number>> = {}): Promise<DgRun> {
	const fake = fakeMounts(exitCodes);
	let stdout = "";
	let stderr = "";
	const out = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as never);
	const err = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as never);
	try {
		const code = await main(argv, fake.mounts);
		return { ...fake, code, stdout, stderr };
	} finally {
		out.mockRestore();
		err.mockRestore();
		setProgramName(undefined);
	}
}
