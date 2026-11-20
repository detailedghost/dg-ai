import { join } from "node:path";
import {
	type ChannelState,
	type ChannelReviewPaths,
	channelReviewPaths,
	createSystemPlatform,
	type EnvName,
	type HandledStatus,
	isOurDaemon,
	loadConfig,
	type PlatformSeam,
	readPidRecord,
	readStateSnapshot,
} from "@dg/channel-review";
import { describeError } from "@dg/common";
import { ensurePrivateDir, isJobName, jobStateDir, writeFileAtomic } from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";

export type ExportFlags = { env: EnvName; label: string };

type ImportFile = {
	version: 1;
	cursor: ChannelState["lastEventIds"];
	handled: Array<{ messageId: string; status: HandledStatus; at: string; chatId?: string }>;
	current: ChannelState["current"];
	automation: {
		blocked: ChannelState["blocked"];
		issues: ChannelState["issues"];
		sinks: ChannelState["sinks"];
		prWatch: ChannelState["prWatch"];
		deps: { lastRun: ChannelState["deps"]["lastRun"] };
	};
};

const PREFIX = "channel-review export:";

class ExportRefusal extends Error {}

function configuredChatId(configPath: string): string | undefined {
	try {
		return loadConfig(configPath).chats[0]?.id;
	} catch {
		return undefined;
	}
}

function importFileOf(state: ChannelState): ImportFile {
	const handled = Object.entries(state.handled)
		.map(([messageId, { status, at, chatId }]) => ({
			messageId,
			status,
			at,
			...(chatId === undefined ? {} : { chatId }),
		}))
		.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.messageId < y.messageId ? -1 : x.messageId > y.messageId ? 1 : 0));
	return {
		version: 1,
		cursor: state.lastEventIds,
		handled,
		current: state.current,
		automation: {
			blocked: state.blocked,
			issues: state.issues,
			sinks: state.sinks,
			prWatch: state.prWatch,
			deps: { lastRun: state.deps.lastRun },
		},
	} satisfies ImportFile;
}

async function writeExport(
	{ env, label }: ExportFlags,
	paths: ChannelReviewPaths,
	platform: PlatformSeam,
): Promise<{ target: string; file: ImportFile }> {
	const record = readPidRecord(paths.pidPath);
	if (record !== undefined && (await isOurDaemon(record.pid, platform))) {
		throw new ExportRefusal(
			`the ${env} daemon is running (pid ${record.pid}) — stop it first with dg-skills channel-review stop --env ${env}`,
		);
	}
	const chatId = configuredChatId(paths.configPath);
	const state = readStateSnapshot(paths, chatId);
	if ("lastEventId" in state && chatId === undefined) {
		throw new ExportRefusal(`the ${env} state has a legacy cursor and no chat id is configured`);
	}
	const file = importFileOf(state);
	const dir = jobStateDir(paths.dg, label);
	ensurePrivateDir(dir);
	const target = join(dir, "import.json");
	writeFileAtomic(target, `${JSON.stringify(file, null, "\t")}\n`, 0o600);
	return { target, file };
}

/** Returns the exit code; a layout block error propagates so its own exit code survives. */
export async function runExport(
	flags: ExportFlags,
	io: { out: (line: string) => void; err: (line: string) => void },
	platform: PlatformSeam = createSystemPlatform(),
): Promise<number> {
	const { env, label } = flags;
	if (!isJobName(label)) {
		io.err(`${PREFIX} "--label" must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit`);
		return 1;
	}
	const paths = channelReviewPaths(env);
	assertNotBlocked(paths.dg, "channel-review-config");
	assertNotBlocked(paths.dg, "daemon");
	try {
		const { target, file } = await writeExport(flags, paths, platform);
		io.out(
			`exported channel-review ${env} state to ${target}: ${file.handled.length} handled, ${Object.keys(file.cursor).length} chat cursors, current ${file.current?.messageId ?? "none"}`,
		);
		return 0;
	} catch (error) {
		const text = error instanceof ExportRefusal ? error.message : describeError(error).split("\n")[0];
		io.err(`${PREFIX} ${text}`);
		return 1;
	}
}
