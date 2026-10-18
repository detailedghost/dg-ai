import { spawn } from "node:child_process";
import { constants } from "node:os";

/** Stream native output without accumulating build logs; merged mode implements 2>&1. */
export function runNative(
	command: string,
	args: string[],
	cwd: string,
	merged = false,
): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["inherit", "inherit", merged ? 1 : "inherit"],
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			(merged ? process.stdout : process.stderr).write(
				`${command}: ${error.message}\n`,
			);
			resolve(error.code === "ENOENT" ? 127 : 126);
		});
		child.on("close", (code, signal) =>
			resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)),
		);
	});
}
