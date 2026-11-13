import { fail, requireRecord, requireString } from "./assert";
import { CREDENTIAL_NAME_PATTERN, validateCredentialMeta, validateCredentialValue } from "./credentials-format";

/** Store prefix of every value that pw --ext credential save writes. */
export const PW_EXT_CREDENTIAL_PREFIX = "pw";
export const PW_EXT_CREDENTIAL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const PW_EXT_CREDENTIAL_SITE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
export const PW_EXT_CREDENTIAL_SOURCES = ["cookie", "header", "local", "session"] as const;
export type PwExtCredentialSource = (typeof PW_EXT_CREDENTIAL_SOURCES)[number];

/** The store name of a saved value: pw/<registrable domain>/<name>. */
export function pwExtCredentialName(site: string, name: string): string {
	const full = `${PW_EXT_CREDENTIAL_PREFIX}/${site}/${name}`;
	if (!PW_EXT_CREDENTIAL_SITE.test(site) || !PW_EXT_CREDENTIAL_NAME.test(name) || !CREDENTIAL_NAME_PATTERN.test(full))
		fail("credential site or name is not valid");
	return full;
}

/** Checks the extension-to-daemon store frame; no failure message echoes the value. */
export function validatePwExtCredentialStore(value: Record<string, unknown>, path: string): void {
	requireString(value.token, `${path}.token`, { nonEmpty: true });
	requireString(value.requestId, `${path}.requestId`, { nonEmpty: true });
	if ((value.requestId as string).length > 128) fail(`${path}.requestId is too long`);
	requireString(value.site, `${path}.site`, { nonEmpty: true });
	requireString(value.name, `${path}.name`, { nonEmpty: true });
	pwExtCredentialName(value.site as string, value.name as string);
	try {
		validateCredentialValue(value.value);
	} catch {
		fail(`${path}.value must be a non-empty string within the credential size limit`);
	}
	requireRecord(value.meta, `${path}.meta`);
	validateCredentialMeta(value.meta);
}

/** Checks the daemon's reply to a store frame. */
export function validatePwExtCredentialStored(value: Record<string, unknown>, path: string): void {
	requireString(value.requestId, `${path}.requestId`, { nonEmpty: true });
	if (typeof value.ok !== "boolean") fail(`${path}.ok must be a boolean`);
	if (value.name !== undefined) requireString(value.name, `${path}.name`);
	if (value.error !== undefined) requireString(value.error, `${path}.error`, { nonEmpty: true });
}
