export const MAILBOX_BOUNDARY_ERROR_CODES = [
	"invalid_type",
	"invalid_value",
	"invalid_key",
	"unknown_key",
	"missing_key",
	"prototype_key",
	"non_plain_object",
	"accessor_property",
	"symbol_property",
	"cyclic_value",
	"depth_limit",
	"size_limit",
	"non_finite_number",
	"invalid_timestamp",
	"invalid_alias",
	"duplicate_alias",
	"broken_reference",
	"invalid_fingerprint",
	"unsupported_schema",
	"unsupported_action",
] as const;

export type MailboxBoundaryErrorCode =
	(typeof MAILBOX_BOUNDARY_ERROR_CODES)[number];

const SAFE_MESSAGES: Record<MailboxBoundaryErrorCode, string> = {
	invalid_type: "Mailbox value has an invalid type",
	invalid_value: "Mailbox value is invalid",
	invalid_key: "Mailbox value has an invalid key",
	unknown_key: "Mailbox value has an unknown key",
	missing_key: "Mailbox value is missing a required key",
	prototype_key: "Mailbox value contains a prototype-pollution key",
	non_plain_object: "Mailbox value must contain plain objects only",
	accessor_property: "Mailbox value cannot contain accessor properties",
	symbol_property: "Mailbox value cannot contain symbol properties",
	cyclic_value: "Mailbox value cannot contain a cyclic reference",
	depth_limit: "Mailbox value exceeds the depth limit",
	size_limit: "Mailbox value exceeds a size limit",
	non_finite_number: "Mailbox value contains a non-finite number",
	invalid_timestamp: "Mailbox value contains an invalid timestamp",
	invalid_alias: "Mailbox value contains an invalid scoped alias",
	duplicate_alias: "Mailbox value contains a duplicate alias",
	broken_reference: "Mailbox value contains a broken alias reference",
	invalid_fingerprint: "Mailbox value contains an unversioned fingerprint",
	unsupported_schema: "Mailbox schema version is unsupported",
	unsupported_action: "Mailbox action type is unsupported",
};

/**
 * A deliberately bounded boundary error. It never includes input values,
 * property paths, DOM text, URLs, thrown messages, or stacks in its message.
 */
export class MailboxBoundaryError extends Error {
	override readonly name = "MailboxBoundaryError";

	constructor(readonly code: MailboxBoundaryErrorCode) {
		super(SAFE_MESSAGES[code]);
	}
}

export function failMailboxBoundary(
	code: MailboxBoundaryErrorCode,
): never {
	throw new MailboxBoundaryError(code);
}
