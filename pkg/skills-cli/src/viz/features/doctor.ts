import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { vizConfig } from "../config";
import {
	detectOpener,
	fetchServerMeta,
	portInUse,
	verifyServerIdentity,
} from "../server";

interface DoctorResult {
	bun: boolean;
	port_free_or_ours: boolean;
	server_reachable: boolean;
	browser_openable: boolean;
	viz_dir_writable: boolean;
	usable: boolean;
	server_viz_dir: string | null;
	server_viz_dir_matches: boolean;
	server_pid_identity_ok: boolean | null;
}

function checkDirWritable(dir: string): boolean {
	try {
		if (!existsSync(dir)) return false;
		accessSync(dir, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

async function checkServerReachable(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/`, {
			method: "HEAD",
			signal: AbortSignal.timeout(3000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

const UNUSABLE: DoctorResult = {
	bun: false,
	port_free_or_ours: false,
	server_reachable: false,
	browser_openable: false,
	viz_dir_writable: false,
	usable: false,
	server_viz_dir: null,
	server_viz_dir_matches: false,
	server_pid_identity_ok: null,
};

async function probe(): Promise<DoctorResult> {
	const { pidFile, port, vizDir } = vizConfig();
	const [portOccupied, reachable, meta] = await Promise.all([
		portInUse(),
		checkServerReachable(port),
		fetchServerMeta(),
	]);
	const writable = checkDirWritable(vizDir);
	const bun = Bun.which("bun") !== null;
	const browserOpenable =
		detectOpener() !== null && process.env.VIZ_NO_BROWSER !== "1";

	let pidIdentityOk: boolean | null = null;
	if (existsSync(pidFile)) {
		const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
		pidIdentityOk = Number.isNaN(pid) ? false : verifyServerIdentity(pid);
	}

	return {
		bun,
		port_free_or_ours: !portOccupied || reachable,
		server_reachable: reachable,
		browser_openable: browserOpenable,
		viz_dir_writable: writable,
		usable: bun && writable && browserOpenable,
		server_viz_dir: meta?.vizDir ?? null,
		server_viz_dir_matches:
			meta !== null && resolvePath(meta.vizDir) === resolvePath(vizDir),
		server_pid_identity_ok: pidIdentityOk,
	};
}

export async function cmdDoctor(rest: string[]): Promise<void> {
	let result: DoctorResult;
	try {
		result = await probe();
	} catch {
		result = UNUSABLE;
	}

	if (rest.includes("--json")) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	const tick = (v: boolean) => (v ? "✓" : "✗");
	process.stdout.write(
		`${[
			`bun            ${tick(result.bun)}`,
			`port free/ours ${tick(result.port_free_or_ours)}`,
			`server         ${tick(result.server_reachable)}`,
			`browser        ${tick(result.browser_openable)}`,
			`viz dir writable ${tick(result.viz_dir_writable)}`,
			`usable         ${tick(result.usable)}`,
			`server viz dir  ${result.server_viz_dir ?? "(none)"} ${
				result.server_viz_dir ? tick(result.server_viz_dir_matches) : ""
			}`,
		].join("\n")}\n`,
	);
}
