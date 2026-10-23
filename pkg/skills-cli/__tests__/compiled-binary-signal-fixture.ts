import { buildCompiledBinary } from "./compiled-binary";

const binary = buildCompiledBinary();
process.stdout.write(`${binary}\n`);
setInterval(() => {}, 1_000);
