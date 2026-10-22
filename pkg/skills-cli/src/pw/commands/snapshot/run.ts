import { stringFlag } from "../../core/args";
import type { DaemonHandler } from "../../core/spec";

export function parseDepth(value: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`Invalid --depth '${value}': use a non-negative integer`);
	return Number(value);
}

const snapshot: DaemonHandler = async (_ctx, args) => {
	const depthFlag = stringFlag(args, "depth");
	const depth = args.flags["full"] === true ? 0 : depthFlag === undefined ? undefined : parseDepth(depthFlag);
	return { snapshot: { target: args.positionals[0], depth, filename: stringFlag(args, "filename") } };
};

export default snapshot;
