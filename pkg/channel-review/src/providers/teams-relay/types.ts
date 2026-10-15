import type { Log } from "../../engine";
import type { Sleep } from "./sleep";

export type ProviderSeams = {
	fetch: typeof globalThis.fetch;
	secret: string;
	sleep?: Sleep;
	now?: () => number;
	random?: () => number;
	log?: Log;
};
