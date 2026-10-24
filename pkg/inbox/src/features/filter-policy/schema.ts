import { z } from "zod";
import { defaultNamingPolicy, type NamingPolicy } from "./naming";
import type { SafetyPolicy } from "./safety";

const namingSchema = z.object({
	folderSlugPattern: z.string().min(1).default(defaultNamingPolicy().folderSlugPattern),
	folderExceptions: z.array(z.string()).default([]),
});

const safetySchema = z.object({
	protectedPlusAlias: z.string().default(""),
	verificationSenders: z.array(z.string()).default([]),
	blockedDestinations: z.array(z.string()).default([]),
});

const filterSchema = z.object({
	name: z.string().min(1),
	enabled: z.boolean().default(true),
	sieve: z.string().min(1),
	protonId: z.string().min(1).optional(),
});

const folderSchema = z.object({
	path: z.string().min(1),
	type: z.enum(["folder", "label", "system"]).default("folder"),
	protonId: z.string().min(1).optional(),
});

const observedFilterSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	enabled: z.boolean(),
	sieve: z.string(),
	sequence: z.number().int().nonnegative().optional(),
});

const observedFolderSchema = z.object({
	id: z.string().min(1),
	path: z.string().min(1),
	name: z.string().min(1),
	type: z.enum(["folder", "label", "system"]),
});

export const declaredFiltersSchema = z
	.object({
		kind: z.literal("declared-filters"),
		version: z.literal(1),
		provider: z.literal("protonmail"),
		policy: z
			.object({
				naming: namingSchema.default({
					folderSlugPattern: defaultNamingPolicy().folderSlugPattern,
					folderExceptions: [],
				}),
				safety: safetySchema.default({
					protectedPlusAlias: "",
					verificationSenders: [],
					blockedDestinations: [],
				}),
				keepFirst: z.array(z.string()).default([]),
			})
			.default({
				naming: {
					folderSlugPattern: defaultNamingPolicy().folderSlugPattern,
					folderExceptions: [],
				},
				safety: {
					protectedPlusAlias: "",
					verificationSenders: [],
					blockedDestinations: [],
				},
				keepFirst: [],
			}),
		folders: z.array(folderSchema).default([]),
		filters: z.array(filterSchema),
		observed: z
			.object({
				filters: z.array(observedFilterSchema),
				folders: z.array(observedFolderSchema),
			})
			.optional(),
	})
	.strict();

export type DeclaredFilter = z.infer<typeof filterSchema>;
export type DeclaredFolder = z.infer<typeof folderSchema>;
export type DeclaredFiltersFile = z.infer<typeof declaredFiltersSchema>;

export type DeclaredPolicy = {
	naming: NamingPolicy;
	safety: SafetyPolicy;
	keepFirst: string[];
};

export function emptyDeclaredFilters(): DeclaredFiltersFile {
	return declaredFiltersSchema.parse({
		kind: "declared-filters",
		version: 1,
		provider: "protonmail",
		filters: [],
	});
}

export function parseDeclaredFilters(value: unknown): DeclaredFiltersFile {
	const parsed = declaredFiltersSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			`Declared filters file is invalid: ${parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	return parsed.data;
}
