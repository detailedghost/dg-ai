import { rmSync } from "node:fs";
import { describeError, wait } from "@dg/common";
import type { SystemSeams } from "@dg/common/node";
import { type EnvName, loadConfig, resolveEnv } from "../config";
import { createGrantCredentialSource, resolveSecrets } from "../credentials";
import { channelReviewPaths } from "../paths";
import { connect } from "./connect";
import { isOurDaemon, readPidRecord } from "./pid";
import { type PlatformSeam, platformAlive, sendSignal } from "./platform";
import { buildEngine } from "./serve";
import {
	assertEnvName,
	type DaemonIo,
	type DaemonSeams,
	ioLog,
	POLL_INTERVAL_MS,
	savedEnvName,
} from "./shared";

const TERM_TIMEOUT_MS = 15_000;

type StopSeams = DaemonSeams & {
	platform: PlatformSeam;
	io: DaemonIo;
	system?: SystemSeams;
	termTimeoutMs?: number;
	pollIntervalMs?: number;
};

async function recoverAfterKill(
	env: EnvName,
	system: SystemSeams,
	seams: StopSeams,
): Promise<void> {
	const { io, platform } = seams;
	try {
		const config = loadConfig(channelReviewPaths(env, system).configPath);
		const resolved = resolveEnv(config, env);
		const log = ioLog(io);
		const secrets = await resolveSecrets({
			envName: resolved.name,
			env: seams.env ?? process.env,
			source: seams.credentials ?? createGrantCredentialSource(system),
		});
		if (secrets.warning) log.warn(secrets.warning);
		const { provider, chats } = await connect({
			config,
			env: resolved,
			overrides: {},
			seams: { ...seams, env: secrets.env },
			log,
		});
		const { engine, state, process: processes } = buildEngine({
			config,
			provider,
			defaultChatId: chats[0].id,
			botName: resolved.botName,
			paths: channelReviewPaths(env, system),
			seams,
			log,
			funPool: [],
			platform,
		});
		try {
			await engine.recover(processes);
		} finally {
			state.close();
		}
	} catch (error) {
		io.err(
			[
				`could not report the interrupted review (${describeError(error)});`,
				"the next start does it",
			].join(" "),
		);
	}
}

export async function stop(
	options: { env?: string },
	seams: StopSeams,
): Promise<number> {
	const { platform, io } = seams;
	const system = seams.system ?? {};
	let name: EnvName;
	try {
		name = assertEnvName(options.env ?? savedEnvName(system));
	} catch (error) {
		io.err(describeError(error));
		return 1;
	}
	const paths = channelReviewPaths(name, system);
	const record = readPidRecord(paths.pidPath);
	if (record === undefined || !(await isOurDaemon(record.pid, platform))) {
		io.out("not running");
		return 0;
	}

	if (platform.platform === "win32") {
		await platform.killTree(record.pid);
		await recoverAfterKill(name, system, seams);
	} else {
		sendSignal(record.pid, "SIGTERM", platform);
		const deadline = Date.now() + (seams.termTimeoutMs ?? TERM_TIMEOUT_MS);
		while (platformAlive(record.pid, platform) && Date.now() < deadline) {
			await wait(seams.pollIntervalMs ?? POLL_INTERVAL_MS);
		}
		if (platformAlive(record.pid, platform)) {
			sendSignal(record.pid, "SIGKILL", platform);
		}
	}
	rmSync(paths.pidPath, { force: true });
	io.out(`stopped the ${name} daemon (pid ${record.pid})`);
	return 0;
}
