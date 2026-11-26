import { dispatch, isVersionOnly, reexecWithoutJit } from "./dispatch";

await reexecWithoutJit(process.argv.slice(2));

const code = await dispatch(process.argv.slice(2), process.argv0);
if (code !== 0 || !isVersionOnly(process.argv.slice(2))) {
	const { exitAfterDrain } = await import("@dg/common/exit");
	await exitAfterDrain(code);
}
