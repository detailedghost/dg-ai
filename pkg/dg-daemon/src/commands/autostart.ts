import { DgCliError, EXIT_GENERAL_FAILURE, EXIT_LAYOUT_BLOCKED, EXIT_WSL_NAT_NETWORKING } from "@dg/common";
import {
	type AutostartDeps,
	type AutostartKind,
	autostartInstalled,
	defaultAutostartDeps,
	firstLine,
	type DgPaths,
	installAutostart,
	isDaemonLive,
	readPidFile,
	removeAutostart,
	resolveDgPaths,
	windowsTaskXmlBytes,
} from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";
import { launcherCommand } from "@dg/common/node/program";
import { join } from "node:path";

const NAME = "dg-daemon";
const HAND_OVER = "a daemon is already running outside the service manager; run dg-daemon restart to hand it over";
const STOP_FIRST = "hint: run dg-daemon stop first; the service manager has a shorter stop limit";
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["linux", "darwin", "win32"]);
const DISTRO_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

function wslDistro(deps: AutostartDeps): string | undefined {
	return deps.platform === "linux" ? deps.env.WSL_DISTRO_NAME : undefined;
}

const wslTaskName = (distro: string): string => `dg-daemon-wsl-${distro}`;
const wslTaskXmlPath = (paths: DgPaths): string => join(paths.daemonDir, "dg-daemon-wsl.task.xml");

async function daemonIsLive(paths: DgPaths): Promise<boolean> {
	const handle = readPidFile(paths);
	return handle !== undefined && (await isDaemonLive(handle));
}

async function registerWslTask(deps: AutostartDeps, paths: DgPaths, distro: string): Promise<void> {
	const xmlPath = wslTaskXmlPath(paths);
	const xml = windowsTaskXmlBytes({
		name: NAME,
		argv: ["wsl.exe", "-d", distro, "--exec", "true"],
		logPath: join(paths.logDir, "dg-daemon-autostart.log"),
	});
	deps.writeFile(xmlPath, xml, 0o600);
	const converted = await deps.run(["wslpath", "-w", xmlPath]);
	if (converted.code !== 0) throw new Error(`wslpath -w ${xmlPath} failed: ${firstLine(converted.stderr)}`);
	const create = ["schtasks.exe", "/Create", "/TN", wslTaskName(distro), "/XML", converted.stdout.trim(), "/F"];
	const created = await deps.run(create);
	if (created.code !== 0) throw new Error(`${create.join(" ")} failed: ${firstLine(created.stderr)}`);
}

async function enableLinger(deps: AutostartDeps): Promise<void> {
	const linger = await deps.run(["loginctl", "enable-linger"]);
	if (linger.code !== 0) throw new Error(`loginctl enable-linger failed: ${firstLine(linger.stderr)}`);
}

/** Installs the login unit without printing; throws `DgCliError` with exit code 1. */
export async function installDaemonAutostart(deps: AutostartDeps, paths: DgPaths): Promise<{ kind: AutostartKind }> {
	if (deps.platform === "win32" && deps.env.DG_HOME) {
		throw new DgCliError("a scheduled task cannot pass DG_HOME; unset DG_HOME, then run the command again", EXIT_GENERAL_FAILURE);
	}
	if (!SUPPORTED_PLATFORMS.has(deps.platform)) {
		throw new DgCliError(`unsupported platform "${deps.platform}"`, EXIT_GENERAL_FAILURE);
	}
	const argv = launcherCommand(paths.dataDir, NAME, ["serve"]);
	for (const file of [argv[0], argv[1]] as string[]) {
		if (!deps.fileExists(file)) throw new DgCliError(`${file} is missing; install dg first`, EXIT_GENERAL_FAILURE);
	}
	const distro = wslDistro(deps);
	if (distro !== undefined && !DISTRO_PATTERN.test(distro)) {
		throw new DgCliError(`WSL_DISTRO_NAME "${distro}" is not valid`, EXIT_GENERAL_FAILURE);
	}
	const outcome = await installAutostart(deps, paths, {
		name: NAME,
		argv,
		dgHome: deps.env.DG_HOME || undefined,
		logPath: join(paths.logDir, "dg-daemon-autostart.log"),
		restartPreventExitStatus: [EXIT_WSL_NAT_NETWORKING, EXIT_LAYOUT_BLOCKED],
	}).catch((err: unknown) => {
		throw new DgCliError(err instanceof Error ? err.message : String(err), EXIT_GENERAL_FAILURE);
	});
	if (!outcome.ok) throw new DgCliError(outcome.reason, EXIT_GENERAL_FAILURE);
	if (outcome.kind !== "systemd") return { kind: outcome.kind };
	try {
		await enableLinger(deps);
		if (distro !== undefined) await registerWslTask(deps, paths, distro);
	} catch (err) {
		await removeAutostart(deps, paths, NAME);
		deps.removeFile(wslTaskXmlPath(paths));
		throw new DgCliError(err instanceof Error ? err.message : String(err), EXIT_GENERAL_FAILURE);
	}
	return { kind: outcome.kind };
}

export async function cmdAutostartInstall(deps: AutostartDeps = defaultAutostartDeps()): Promise<void> {
	const paths = resolveDgPaths();
	assertNotBlocked(paths, "daemon");
	const wasInstalled = autostartInstalled(deps, paths, NAME) !== undefined;
	const wasLive = await daemonIsLive(paths);
	const { kind } = await installDaemonAutostart(deps, paths).catch((err: unknown) => {
		if (!(err instanceof DgCliError)) throw err;
		throw new DgCliError(`autostart install: ${err.message}`, EXIT_GENERAL_FAILURE);
	});
	console.log(`autostart installed (${kind}): dg-daemon starts at login`);
	if (wasLive && !wasInstalled) console.log(HAND_OVER);
}

export async function cmdAutostartRemove(deps: AutostartDeps = defaultAutostartDeps()): Promise<void> {
	const paths = resolveDgPaths();
	const distro = wslDistro(deps);
	const hasWslTask = distro !== undefined && deps.fileExists(wslTaskXmlPath(paths));
	const installed = autostartInstalled(deps, paths, NAME);
	if (installed && (await daemonIsLive(paths))) console.log(STOP_FIRST);
	const result = await removeAutostart(deps, paths, NAME);
	if (distro !== undefined && DISTRO_PATTERN.test(distro) && (result === "removed" || hasWslTask)) {
		await deps.run(["schtasks.exe", "/Delete", "/TN", wslTaskName(distro), "/F"]);
		deps.removeFile(wslTaskXmlPath(paths));
	}
	console.log(result === "removed" ? "autostart removed" : "autostart: not installed");
}

export async function cmdAutostartStatus(
	options: { json?: boolean } = {},
	deps: AutostartDeps = defaultAutostartDeps(),
): Promise<void> {
	const paths = resolveDgPaths();
	const kind = autostartInstalled(deps, paths, NAME);
	const wslTask = wslDistro(deps) === undefined ? undefined : deps.fileExists(wslTaskXmlPath(paths));
	if (options.json) {
		console.log(JSON.stringify({ installed: kind !== undefined, kind: kind ?? null, ...(wslTask === undefined ? {} : { wslTask }) }));
		return;
	}
	console.log(kind ? `autostart: installed (${kind})` : "autostart: not installed");
	if (wslTask !== undefined) console.log(`wsl task: ${wslTask ? "installed" : "not installed"}`);
}
