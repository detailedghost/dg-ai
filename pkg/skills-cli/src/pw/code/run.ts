import type { Page } from "playwright-core";
import { stringFlag, UsageError } from "../core/args";
import { readInput } from "../core/files";
import type { DaemonHandler } from "../core/spec";

export function toRunnable(source: string): (page: Page) => Promise<unknown> {
	const body = source.trim().replace(/;+$/, "");
	try {
		return new Function("page", `return (${body})(page)`) as (page: Page) => Promise<unknown>;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid code: ${reason}. Pass a function such as: async (page) => { ... }`);
	}
}

const runCode: DaemonHandler = async (ctx, args) => {
	const filename = stringFlag(args, "filename");
	const source = filename ? await readInput(ctx.clientCwd, filename) : args.positionals[0];
	if (!source?.trim()) throw new UsageError("Provide the code as an argument or with --filename");
	const value = await toRunnable(source)(ctx.page());
	const code = `await (${source.trim().replace(/;+$/, "")})(page);`;
	if (value === undefined) return { code, snapshot: true };
	return { result: JSON.stringify(value, null, 2) ?? String(value), code, snapshot: true };
};

export default runCode;
