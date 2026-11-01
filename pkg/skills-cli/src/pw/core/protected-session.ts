import { commandName, normalize, optionArgs } from "./args";

export const PROTECTED_SESSIONS: readonly string[] = ["inbox-proton"];

const SECRET_COMMANDS = new Set(["cookie-list", "cookie-get", "state-save"]);

/** Refuses the public pw commands that would copy credentials out of a signed-in mailbox session. */
export function protectedSessionRefusal(
	argv: readonly string[],
): string | undefined {
	let args: string[];
	try {
		args = normalize(argv);
	} catch {
		return undefined;
	}
	const options = optionArgs(args);
	const session =
		options
			.findLast((arg) => arg.startsWith("--session="))
			?.slice("--session=".length) ?? process.env["PLAYWRIGHT_CLI_SESSION"];
	if (!session || !PROTECTED_SESSIONS.includes(session)) return undefined;
	const name = commandName(args);
	const refused =
		(name !== undefined && SECRET_COMMANDS.has(name)) ||
		(name === "network" && options.includes("--request-headers"));
	return refused
		? `pw refuses ${name} on the ${session} session: it holds a signed-in mailbox.`
		: undefined;
}
