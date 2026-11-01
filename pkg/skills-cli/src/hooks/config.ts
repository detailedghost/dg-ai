import { readDgConfig } from "@dg/common/node";
import { HOOKS } from "./manifest";
import type { HookEnv } from "./types";

export function hookSetting(
	hookId: string,
	key: string,
	env: HookEnv,
	warn: (message: string) => void = () => {},
): string {
	const spec = HOOKS.find((h) => h.id === hookId)?.settings?.[key];
	if (!spec) throw new Error(`hook ${hookId} has no setting ${key}`);
	let hooks: Record<string, Record<string, unknown> | undefined> | undefined;
	try {
		hooks = readDgConfig(env).hooks as typeof hooks;
	} catch (error) {
		warn(
			`hooks: config.json is unreadable (${error instanceof Error ? error.message : String(error)}); using ${spec.default} for ${hookId}.${key}\n`,
		);
		return spec.default;
	}
	const value = hooks?.[hookId]?.[key];
	if (value === undefined) return spec.default;
	const match =
		typeof value === "string"
			? spec.values.find((v) => v.toLowerCase() === value.toLowerCase())
			: undefined;
	if (match) return match;
	warn(
		`hooks: ${hookId}.${key} is ${JSON.stringify(value)} but must be one of ${spec.values.join(", ")}; using ${spec.default}\n`,
	);
	return spec.default;
}
