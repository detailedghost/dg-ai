import { failMailboxBoundary } from "./errors";

export type MailboxPreflightLimits = Readonly<{
	maxDepth: number;
	maxNodes: number;
	maxKeys: number;
	maxArrayLength: number;
	maxStringLength: number;
	maxTotalStringLength: number;
	maxStringBytes: number;
	maxTotalBytes: number;
}>;

export const DEFAULT_MAILBOX_PREFLIGHT_LIMITS: MailboxPreflightLimits =
	Object.freeze({
		maxDepth: 16,
		maxNodes: 20_000,
		maxKeys: 20_000,
		maxArrayLength: 10_000,
		maxStringLength: 16_384,
		maxTotalStringLength: 1_000_000,
		maxStringBytes: 65_536,
		maxTotalBytes: 2_000_000,
	});

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function positiveLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function validateLimits(
	overrides: Partial<MailboxPreflightLimits>,
): MailboxPreflightLimits {
	const limits = { ...DEFAULT_MAILBOX_PREFLIGHT_LIMITS, ...overrides };
	if (
		!positiveLimit(limits.maxDepth) ||
		!positiveLimit(limits.maxNodes) ||
		!positiveLimit(limits.maxKeys) ||
		!positiveLimit(limits.maxArrayLength) ||
		!positiveLimit(limits.maxStringLength) ||
		!positiveLimit(limits.maxTotalStringLength) ||
		!positiveLimit(limits.maxStringBytes) ||
		!positiveLimit(limits.maxTotalBytes)
	) {
		failMailboxBoundary("invalid_value");
	}
	return limits;
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

/**
 * Performs a side-effect-free walk before any mailbox value is inspected by a
 * schema validator. Accessors are rejected from descriptors and are never read.
 */
export function preflightMailboxValue(
	value: unknown,
	overrides: Partial<MailboxPreflightLimits> = {},
): void {
	const limits = validateLimits(overrides);
	const ancestors = new Set<object>();
	let nodes = 0;
	let keys = 0;
	let totalStringLength = 0;
	let totalBytes = 0;

	const addBytes = (value: string): void => {
		const bytes = utf8ByteLength(value);
		if (bytes > limits.maxStringBytes) failMailboxBoundary("size_limit");
		totalBytes += bytes;
		if (totalBytes > limits.maxTotalBytes) {
			failMailboxBoundary("size_limit");
		}
	};

	const visit = (current: unknown, depth: number): void => {
		nodes += 1;
		if (nodes > limits.maxNodes) failMailboxBoundary("size_limit");
		if (depth > limits.maxDepth) failMailboxBoundary("depth_limit");

		if (typeof current === "string") {
			if (current.length > limits.maxStringLength) {
				failMailboxBoundary("size_limit");
			}
			totalStringLength += current.length;
			if (totalStringLength > limits.maxTotalStringLength) {
				failMailboxBoundary("size_limit");
			}
			addBytes(current);
			return;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current)) {
				failMailboxBoundary("non_finite_number");
			}
			return;
		}
		if (
			current === null ||
			typeof current === "boolean"
		) {
			return;
		}
		if (
			typeof current === "undefined" ||
			typeof current === "bigint" ||
			typeof current === "function"
		) {
			failMailboxBoundary("invalid_type");
		}
		if (typeof current === "symbol") {
			failMailboxBoundary("symbol_property");
		}
		if (typeof current !== "object") failMailboxBoundary("invalid_type");

		if (ancestors.has(current)) failMailboxBoundary("cyclic_value");
		const isArray = Array.isArray(current);
		const prototype = Object.getPrototypeOf(current);
		if (
			(!isArray &&
				prototype !== Object.prototype &&
				prototype !== null) ||
			(isArray && prototype !== Array.prototype)
		) {
			failMailboxBoundary("non_plain_object");
		}
		if (isArray && current.length > limits.maxArrayLength) {
			failMailboxBoundary("size_limit");
		}

		ancestors.add(current);
		const ownKeys = Reflect.ownKeys(current);
		keys += ownKeys.length;
		if (keys > limits.maxKeys) failMailboxBoundary("size_limit");
		for (const key of ownKeys) {
			if (typeof key === "symbol") failMailboxBoundary("symbol_property");
			if (POLLUTION_KEYS.has(key)) failMailboxBoundary("prototype_key");
			if (key.length > 256) failMailboxBoundary("size_limit");
			addBytes(key);
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor) failMailboxBoundary("invalid_key");
			if ("get" in descriptor || "set" in descriptor) {
				failMailboxBoundary("accessor_property");
			}
			if (!(isArray && key === "length") && !descriptor.enumerable) {
				failMailboxBoundary("invalid_key");
			}
			if (isArray && key === "length") continue;
			if (isArray && !/^(0|[1-9]\d*)$/.test(key)) {
				failMailboxBoundary("invalid_key");
			}
			visit(descriptor.value, depth + 1);
		}
		if (isArray && ownKeys.length !== current.length + 1) {
			failMailboxBoundary("invalid_value");
		}
		ancestors.delete(current);
	};

	visit(value, 0);
}
