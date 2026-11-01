import { commandName, normalize, optionArgs } from "./args";

export const PROTECTED_SESSIONS: readonly string[] = ["inbox-proton"];

const ALLOWED_COMMANDS = new Set(["close", "delete-data", "tab-list"]);

/** Refuses public pw and pw-code access to a signed-in mailbox session, except closing or clearing it. */
export function protectedSessionRefusal(
	argv: readonly string[],
	program: "pw" | "pw-code" = "pw",
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
	const name = program === "pw-code" ? program : commandName(args);
	if (name !== undefined && program === "pw" && ALLOWED_COMMANDS.has(name))
		return undefined;
	return `${program} refuses ${name ?? "this command"} on the ${session} session: it holds a signed-in mailbox. Use dg-skills inbox, or close it with pw -s=${session} close.`;
}
