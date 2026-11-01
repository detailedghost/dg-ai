import { askJson, bashCommand } from "../io";
import { invokesPrCommand } from "../pr-command";
import type { HookHandler } from "../types";

const handler: HookHandler = async (input) => {
	if (!invokesPrCommand(bashCommand(input), ["create"])) return { exitCode: 0 };
	return {
		exitCode: 0,
		stdout: askJson("Always confirm with the user before opening a PR"),
	};
};

export default handler;
