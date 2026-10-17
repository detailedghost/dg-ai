import { makeShellTag, redactTokens, type ShellTag } from "../utils/git";
import { ProviderError } from "./types";

/** Provide the stable missing-binary error code and actionable CLI installation/override guidance. */
export interface BinPreflightOptions {
	code: string;
	label: string;
	installHint: string;
	envVar: string;
}

/** Wraps a raw shell tag so a missing CLI binary fails with a readable ProviderError instead of a raw ENOENT. */
export function makeBinPreflightTag(bin: string, opts: BinPreflightOptions): ShellTag {
	const raw = makeShellTag(bin);
	const wrap = (err: unknown): never => {
		if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new ProviderError(
				opts.code,
				`${opts.label} CLI not found at "${redactTokens(bin)}" — install it (${opts.installHint}) or set ${opts.envVar} to its path`,
			);
		}
		throw err;
	};
	const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
		try {
			return await raw(strings, ...values);
		} catch (err) {
			return wrap(err);
		}
	}) as ShellTag;
	tag.withInput = (input: string) => {
		return async (strings: TemplateStringsArray, ...values: unknown[]) => {
			try {
				return await raw.withInput(input)(strings, ...values);
			} catch (err) {
				return wrap(err);
			}
		};
	};
	return tag;
}
