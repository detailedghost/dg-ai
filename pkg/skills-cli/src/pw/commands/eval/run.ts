import { stringFlag } from "../../core/args";
import { writePrivate } from "../../core/files";
import { resolveOutput } from "../../core/response";
import type { DaemonHandler } from "../../core/spec";
import { resolveTarget } from "../../core/targets";

const FUNCTION_LIKE = /^\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/;

export const isFunctionLike = (source: string): boolean => FUNCTION_LIKE.test(source);

type Evaluable = string | (() => unknown);

export function toEvaluable(source: string): Evaluable {
	return isFunctionLike(source) ? Object.assign(() => undefined, { toString: () => source }) : source;
}

const evalCommand: DaemonHandler = async (ctx, args) => {
	const source = args.positionals[0] as string;
	const evaluable = toEvaluable(source);
	const page = ctx.page();
	const element = args.positionals[1];
	const value: unknown = element
		? await (await resolveTarget(page, element)).evaluate(evaluable)
		: await page.evaluate(evaluable);
	const json = JSON.stringify(value, null, 2) ?? "undefined";
	const code = `await page.evaluate(${JSON.stringify(source)});`;
	const filename = stringFlag(args, "filename");
	if (!filename) return { result: json, code };
	const file = resolveOutput(ctx.outputDir, filename);
	writePrivate(file, `${json}\n`);
	return { result: `- [Result](${file})`, code };
};

export default evalCommand;
