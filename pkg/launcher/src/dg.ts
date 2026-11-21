import { dispatch } from "./dispatch";

const code = await dispatch(process.argv.slice(2), process.argv0);
const { exitAfterDrain } = await import("@dg/common/exit");
await exitAfterDrain(code);
