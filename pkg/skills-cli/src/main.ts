import type { CompletionNode } from "@dg/common/completion";
import type { Command } from "commander";
import type { LayoutHooks } from "@dg/common/node/layout";

export const VERSION = process.env.DG_BUILD_VERSION ?? "dev";

const SKIP = new Set(["hooks run", "completion"]);

type HookSeams = { platform?: NodeJS.Platform };

export function hooksFor(commandName: string, seams: HookSeams = {}): LayoutHooks {
	if (commandName !== "install") return {};
	const hooks: LayoutHooks = {
		launchers: true,
		load: async () => {
			const [{ daemonLayoutHooks }, { phoneLayoutHooks }, { resolveDgPaths }, { ssmsConfigDir }] = await Promise.all([
				import("@dg/dg-daemon/layout-hooks"),
				import("@dg/dg-agent/layout-hooks"),
				import("@dg/common/node/dg-paths"),
				import("./install/layout"),
			]);
			const paths = resolveDgPaths();
			Object.assign(hooks, daemonLayoutHooks({ platform: seams.platform }), phoneLayoutHooks(), {
				"ssms.configDir": () => ssmsConfigDir(paths),
			});
		},
	};
	return hooks;
}

type PhoneOutcome = { kind: string; stopped?: boolean } | undefined;

type ListenerRestartSeams = { phoneOutcome: () => Promise<PhoneOutcome>; restart: () => Promise<void> };

const phoneOutcomeOf = async (): Promise<PhoneOutcome> => {
	const [{ layoutResult }, { resolveDgPaths }] = await Promise.all([import("@dg/common/node/layout"), import("@dg/common/node/dg-paths")]);
	return layoutResult(resolveDgPaths())?.phone;
};

const restartListener = async (): Promise<void> => (await import("./install/phone-listener")).restartPhoneListener();

export function registerListenerRestart(program: Command, { phoneOutcome, restart }: ListenerRestartSeams): void {
	let installing = false;
	program.hook("preAction", (_thisCommand, action) => {
		installing = action.name() === "install";
	});
	const restartIfStopped = async (): Promise<void> => {
		if (!installing) return;
		installing = false;
		const phone = await phoneOutcome();
		if ((phone?.kind === "moved" || phone?.kind === "setAside") && phone.stopped) await restart();
	};
	const parse = program.parseAsync.bind(program);
	program.parseAsync = async (...args) => {
		let parsed: Command;
		try {
			parsed = await parse(...args);
		} catch (error) {
			await restartIfStopped().catch(() => undefined);
			throw error;
		}
		await restartIfStopped();
		return parsed;
	};
}

export async function main(argv: readonly string[]): Promise<number> {
	if (argv.length === 1 && argv[0] === "--version") {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}
	if (argv[0] === "__complete") {
		const [{ printCompletions }, { default: tree }] = await Promise.all([
			import("@dg/common/completion"),
			import("./completion/tree.json", { with: { type: "json" } }),
		]);
		return printCompletions(tree as CompletionNode, argv.slice(1));
	}
	const [{ Command, CommanderError }, { registerAll }, { ensureLayout }, { installLayoutPreAction }] =
		await Promise.all([
			import("commander"),
			import("./register-all"),
			import("@dg/common/node/layout"),
			import("@dg/common/node/layout-preaction"),
		]);
	const program = new Command()
		.name("dg-skills")
		.description(
			"Review inboxes, run channel reviews, group marked tabs, play guided tours, compare live-page prototypes, and review finished changes.",
		)
		.showHelpAfterError()
		.version(VERSION)
		.exitOverride();
	program.enablePositionalOptions();
	registerAll(program);
	installLayoutPreAction(program, {
		skip: SKIP,
		hooksFor: (action) => hooksFor(action.name()),
		ensure: ensureLayout,
	});
	registerListenerRestart(program, { phoneOutcome: phoneOutcomeOf, restart: restartListener });
	try {
		await program.parseAsync([...argv], { from: "user" });
		return typeof process.exitCode === "number" ? process.exitCode : 0;
	} catch (err) {
		if (err instanceof CommanderError) return err.exitCode;
		const { DgCliError, describeError, emitRedacted } = await import(
			"@dg/common"
		);
		emitRedacted(
			(line) => console.error(line),
			`dg-skills: ${describeError(err)}`,
		);
		return err instanceof DgCliError ? err.exitCode : 1;
	}
}
