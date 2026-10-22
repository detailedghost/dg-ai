export type ReqType =
	| "SECRET"
	| "CONFIG"
	| "CLOUD_PERM"
	| "SERVICE"
	| "NETWORK"
	| "TOOLCHAIN"
	| "REGISTRY";

export type Phase = "dev" | "build" | "run";

export type GapKind = "undeclared" | "undocumented" | "unused" | "drifted";

export interface Gap {
	kind: GapKind;
	detail: string;
}

/** One inventory row; `value` is set only for non-sensitive types such as toolchain pins. */
export interface Requirement {
	type: ReqType;
	name: string;
	value?: string;
	phase: Phase[];
	source: string;
	where: string;
	proven: boolean;
	gaps: Gap[];
}

export interface SniffReport {
	repo: string;
	total: number;
	gaps: number;
	counts: Record<string, number>;
	requirements: Requirement[];
}
