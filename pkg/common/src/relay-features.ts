import { PW_EXT_RELAY } from "./pw-ext-format";

export const RELAY_FEATURES = [PW_EXT_RELAY] as const;

export type RelayFeatureName = (typeof RELAY_FEATURES)[number]["name"];

export type FeatureNamed<N extends RelayFeatureName> = Extract<
	(typeof RELAY_FEATURES)[number],
	{ name: N }
>;
