import { parse as parseYaml } from "yaml";
import { defaultCleanupConfig, type SmsCleanupConfig } from "./types";

type FlagValue = boolean | string[] | number;

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be a map`);
	}
	return value as Record<string, unknown>;
}

function stringList(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${label} must be a list of strings`);
	}
	return value;
}

function flagSection(
	value: unknown,
	names: readonly string[],
): Record<string, FlagValue> {
	const out: Record<string, FlagValue> = {};
	for (const name of names) out[name] = name.endsWith("_list") ? [] : false;
	const entries = Array.isArray(value) ? value : [asRecord(value, "config section")];
	if (!Array.isArray(value)) {
		const record = asRecord(value, "config section");
		for (const name of names) {
			if (!(name in record)) continue;
			const item = record[name];
			if (name.endsWith("_list")) out[name] = stringList(item, name);
			else if (name.endsWith("_days")) {
				if (typeof item !== "number") throw new Error(`${name} must be a number`);
				out[name] = item;
			} else out[name] = Boolean(item);
		}
		return out;
	}
	for (const entry of entries) {
		if (typeof entry === "string") {
			if (!names.includes(entry)) throw new Error(`unknown config flag ${entry}`);
			out[entry] = true;
			continue;
		}
		const record = asRecord(entry, "config flag");
		for (const [key, item] of Object.entries(record)) {
			if (!names.includes(key)) throw new Error(`unknown config flag ${key}`);
			if (key.endsWith("_list")) out[key] = stringList(item, key);
			else if (key.endsWith("_days")) {
				if (typeof item !== "number") throw new Error(`${key} must be a number`);
				out[key] = item;
			} else out[key] = Boolean(item);
		}
	}
	return out;
}

function bool(value: FlagValue | undefined, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function list(value: FlagValue | undefined, fallback: string[]): string[] {
	return Array.isArray(value) ? value : fallback;
}

function days(value: FlagValue | undefined, fallback: number): number {
	return typeof value === "number" ? value : fallback;
}

export function parseCleanupConfig(value: unknown): SmsCleanupConfig {
	const defaults = defaultCleanupConfig();
	if (value === undefined || value === null) return defaults;
	const raw = asRecord(value, "config");
	const keep =
		raw.keep === undefined
			? null
			: flagSection(raw.keep, [
					"pinned",
					"personal_and_family",
					"health",
					"user_keep_list",
				]);
	const archive =
		raw.archive === undefined
			? null
			: flagSection(raw.archive, [
					"business_promos",
					"completed_delivery_notices",
					"expired_codes_older_than_days",
					"past_nonmedical_reminders",
					"user_archive_list",
				]);
	const spam =
		raw.block_and_report_spam === undefined
			? null
			: flagSection(raw.block_and_report_spam, [
					"political_campaign_poll_fundraising",
					"obvious_scams",
					"user_spam_list",
				]);
	const groups = raw.groups === undefined ? null : asRecord(raw.groups, "groups");
	const scope = raw.scope === undefined ? defaults.scope : String(raw.scope);
	if (scope !== "all" && !/^last_\d+_days$/.test(scope)) {
		throw new Error("scope must be all or last_N_days");
	}
	return {
		allow_delete:
			raw.allow_delete === undefined ? defaults.allow_delete : Boolean(raw.allow_delete),
		allow_send: raw.allow_send === undefined ? defaults.allow_send : Boolean(raw.allow_send),
		flag_ambiguous:
			raw.flag_ambiguous === undefined
				? defaults.flag_ambiguous
				: Boolean(raw.flag_ambiguous),
		dry_run: raw.dry_run === undefined ? defaults.dry_run : Boolean(raw.dry_run),
		scope: scope as SmsCleanupConfig["scope"],
		keep: {
			pinned: keep ? bool(keep.pinned, false) : defaults.keep.pinned,
			personal_and_family: keep
				? bool(keep.personal_and_family, false)
				: defaults.keep.personal_and_family,
			health: keep ? bool(keep.health, false) : defaults.keep.health,
			user_keep_list: keep ? list(keep.user_keep_list, []) : defaults.keep.user_keep_list,
		},
		groups: {
			dev: groups ? stringList(groups.dev ?? [], "groups.dev") : defaults.groups.dev,
			personal_notifications: groups
				? stringList(groups.personal_notifications ?? [], "groups.personal_notifications")
				: defaults.groups.personal_notifications,
		},
		archive: {
			business_promos: archive
				? bool(archive.business_promos, false)
				: defaults.archive.business_promos,
			completed_delivery_notices: archive
				? bool(archive.completed_delivery_notices, false)
				: defaults.archive.completed_delivery_notices,
			expired_codes_older_than_days: archive
				? days(
						archive.expired_codes_older_than_days,
						defaults.archive.expired_codes_older_than_days,
					)
				: defaults.archive.expired_codes_older_than_days,
			past_nonmedical_reminders: archive
				? bool(archive.past_nonmedical_reminders, false)
				: defaults.archive.past_nonmedical_reminders,
			user_archive_list: archive
				? list(archive.user_archive_list, [])
				: defaults.archive.user_archive_list,
		},
		block_and_report_spam: {
			political_campaign_poll_fundraising: spam
				? bool(spam.political_campaign_poll_fundraising, false)
				: defaults.block_and_report_spam.political_campaign_poll_fundraising,
			obvious_scams: spam
				? bool(spam.obvious_scams, false)
				: defaults.block_and_report_spam.obvious_scams,
			user_spam_list: spam
				? list(spam.user_spam_list, [])
				: defaults.block_and_report_spam.user_spam_list,
		},
		never_misclassify_as_spam:
			raw.never_misclassify_as_spam === undefined
				? defaults.never_misclassify_as_spam
				: stringList(raw.never_misclassify_as_spam, "never_misclassify_as_spam"),
	};
}

export function parseCleanupYaml(text: string): SmsCleanupConfig {
	return parseCleanupConfig(parseYaml(text));
}

export function scopeDays(scope: SmsCleanupConfig["scope"]): number | undefined {
	const match = /^last_(\d+)_days$/.exec(scope);
	return match ? Number(match[1]) : undefined;
}
