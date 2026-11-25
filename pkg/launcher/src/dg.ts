import { exitAfterDrain } from "@dg/common/exit";
import { dispatch, reexecWithoutJit } from "./dispatch";

await reexecWithoutJit(process.argv.slice(2));

const code = await dispatch(process.argv.slice(2), process.argv0);
await exitAfterDrain(code);
