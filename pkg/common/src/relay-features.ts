import { INBOX_RELAY } from "./inbox-format";
import { PW_EXT_RELAY } from "./pw-ext-format";

export const RELAY_FEATURES = [INBOX_RELAY, PW_EXT_RELAY] as const;

export type RelayFeatureName = (typeof RELAY_FEATURES)[number]["name"];

export type FeatureNamed<N extends RelayFeatureName> = Extract<
	(typeof RELAY_FEATURES)[number],
	{ name: N }
>;
