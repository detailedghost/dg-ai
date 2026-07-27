import {
	attachMailboxHintProvenance,
	type MailboxInventory,
	type MailboxValidatedHint,
	validateMailboxInferenceOutput,
	validateMailboxInventory,
} from "@dg/common";

export type LocalMailboxInferenceInput = Readonly<{
	schemaVersion: 1;
	inventory: MailboxInventory;
}>;

export type LocalMailboxInferenceAdapter = Readonly<{
	id: string;
	kind: "local";
	infer(
		input: LocalMailboxInferenceInput,
	): unknown | Promise<unknown>;
}>;

export type ValidatedLocalMailboxInferenceOutput = Readonly<{
	schemaVersion: 1;
	hints: readonly MailboxValidatedHint[];
}>;

export class MailboxInferenceContractError extends Error {
	override readonly name = "MailboxInferenceContractError";

	constructor(readonly code: "adapter" | "input" | "output") {
		super(`Mailbox inference rejected: ${code}`);
	}
}

const ADAPTER_ID = /^[a-z][a-z0-9-]{1,62}$/;

/**
 * Exact adapter definition intentionally has no URL, endpoint, token, fetch,
 * mutation, acceptance, execution, selector, or raw-provider data channel.
 */
export function defineLocalMailboxInferenceAdapter(
	adapter: LocalMailboxInferenceAdapter,
): LocalMailboxInferenceAdapter {
	if (
		adapter === null ||
		typeof adapter !== "object" ||
		Array.isArray(adapter) ||
		Object.getPrototypeOf(adapter) !== Object.prototype
	) {
		throw new MailboxInferenceContractError("adapter");
	}
	const keys = Reflect.ownKeys(adapter);
	if (
		keys.some((key) => typeof key === "symbol") ||
		keys.length !== 3 ||
		!["id", "kind", "infer"].every((key) => keys.includes(key))
	) {
		throw new MailboxInferenceContractError("adapter");
	}
	for (const key of keys as string[]) {
		const descriptor = Object.getOwnPropertyDescriptor(adapter, key);
		if (!descriptor || "get" in descriptor || "set" in descriptor) {
			throw new MailboxInferenceContractError("adapter");
		}
	}
	if (
		typeof adapter.id !== "string" ||
		!ADAPTER_ID.test(adapter.id) ||
		adapter.kind !== "local" ||
		typeof adapter.infer !== "function"
	) {
		throw new MailboxInferenceContractError("adapter");
	}
	return Object.freeze({ ...adapter });
}

/** Validate both sides so the model sees scrubbed inventory and returns advice. */
export async function runLocalMailboxInference(
	adapter: LocalMailboxInferenceAdapter,
	input: LocalMailboxInferenceInput,
): Promise<ValidatedLocalMailboxInferenceOutput> {
	const safeAdapter = defineLocalMailboxInferenceAdapter(adapter);
	if (
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Object.prototype ||
		Reflect.ownKeys(input).length !== 2 ||
		!Object.hasOwn(input, "schemaVersion") ||
		!Object.hasOwn(input, "inventory") ||
		input.schemaVersion !== 1
	) {
		throw new MailboxInferenceContractError("input");
	}
	for (const key of Reflect.ownKeys(input)) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || "get" in descriptor || "set" in descriptor) {
			throw new MailboxInferenceContractError("input");
		}
	}
	const inventory = validateMailboxInventory(input.inventory);
	try {
		const output = validateMailboxInferenceOutput(
			await safeAdapter.infer({ schemaVersion: 1, inventory }),
		);
		const validatedAt = new Date().toISOString();
		return {
			...output,
			hints: output.hints.map((hint) =>
				attachMailboxHintProvenance(hint, {
					source: "validated_local",
					validatedAt,
				}),
			),
		};
	} catch (error) {
		if (error instanceof MailboxInferenceContractError) throw error;
		throw new MailboxInferenceContractError("output");
	}
}
