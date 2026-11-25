import { writeFileSync } from "node:fs";
import { settledHeap } from "./heap-slope";

const out = process.env.DG_HEAP_PROBE_OUT;
if (out) {
	process.on("SIGUSR2", () => {
		settledHeap();
		setTimeout(() => writeFileSync(out, JSON.stringify(settledHeap())), 50);
	});
}
