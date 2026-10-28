import { assertVerifyName } from "./names";
import { assertLoopbackUrl, assertSeedCookie, assertSeedHeader } from "./urls";

export interface VerifyCookie {
	name: string;
	value: string;
}

export interface VerifyRole {
	id: string;
	headers: Record<string, string>;
	cookies: VerifyCookie[];
}

export interface VerifyTests {
	cmd?: string[];
	summary?: string;
	passed?: number;
	failed?: number;
}

export interface VerifyItem {
	id: string;
	title: string;
	owner: string;
	beforeUrl: string;
	afterUrl: string;
	targetUrl?: string;
	route?: string;
	beforeRef?: string;
	afterRef?: string;
	menuSelector: string;
	roles: VerifyRole[];
	tests?: VerifyTests;
}

export interface VerifyManifest {
	name: string;
	stackUrl: string;
	items: VerifyItem[];
	tests?: VerifyTests;
}

const DEFAULT_MENU = "[data-verify-menu]";

const TOP_KEYS = new Set(["name", "stackUrl", "items", "tests"]);
const ITEM_KEYS = new Set([
	"id",
	"title",
	"owner",
	"beforeUrl",
	"afterUrl",
	"targetUrl",
	"route",
	"beforeRef",
	"afterRef",
	"menuSelector",
	"roles",
	"tests",
]);
const ROLE_KEYS = new Set(["id", "headers", "cookies"]);
const COOKIE_KEYS = new Set(["name", "value"]);
const TEST_KEYS = new Set(["cmd", "summary", "passed", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} has unknown field ${JSON.stringify(key)}`);
	}
}

function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(`${label} is empty`);
	if (trimmed.length > max || /[\r\n]/.test(trimmed))
		throw new Error(`${label} must be a single line of at most ${max} characters`);
	return trimmed;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
	if (value === undefined) return undefined;
	return text(value, label, max);
}

function count(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new Error(`${label} must be a non-negative integer`);
	return value;
}

function parseTests(value: unknown, label: string): VerifyTests | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	unknownKey(value, TEST_KEYS, label);
	const tests: VerifyTests = {};
	if (value.cmd !== undefined) {
		if (!Array.isArray(value.cmd) || value.cmd.length === 0)
			throw new Error(`${label}.cmd must be a non-empty argv`);
		tests.cmd = value.cmd.map((arg, index) => text(arg, `${label}.cmd[${index}]`, 4000));
	}
	if (value.summary !== undefined) tests.summary = text(value.summary, `${label}.summary`, 4000);
	const passed = count(value.passed, `${label}.passed`);
	const failed = count(value.failed, `${label}.failed`);
	if (passed !== undefined) tests.passed = passed;
	if (failed !== undefined) tests.failed = failed;
	if (!tests.cmd && !tests.summary) throw new Error(`${label} needs cmd or summary`);
	return tests;
}

function parseHeaders(value: unknown, label: string): Record<string, string> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const headers: Record<string, string> = {};
	for (const [name, raw] of Object.entries(value)) {
		const headerValue = text(raw, `${label}.${name}`, 500);
		assertSeedHeader(name, headerValue);
		headers[name] = headerValue;
	}
	return headers;
}

function parseCookies(value: unknown, label: string): VerifyCookie[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`${label}[${index}] must be an object`);
		unknownKey(entry, COOKIE_KEYS, `${label}[${index}]`);
		const name = text(entry.name, `${label}[${index}].name`, 200);
		const cookieValue = text(entry.value, `${label}[${index}].value`, 500);
		assertSeedCookie(name, cookieValue);
		return { name, value: cookieValue };
	});
}

function parseRole(value: unknown, index: number): VerifyRole {
	if (!isRecord(value)) throw new Error(`roles[${index}] must be an object`);
	unknownKey(value, ROLE_KEYS, `roles[${index}]`);
	return {
		id: assertVerifyName(text(value.id, `roles[${index}].id`, 64), "role"),
		headers: parseHeaders(value.headers, `roles[${index}].headers`),
		cookies: parseCookies(value.cookies, `roles[${index}].cookies`),
	};
}

function parseItem(value: unknown, index: number): VerifyItem {
	if (!isRecord(value)) throw new Error(`items[${index}] must be an object`);
	unknownKey(value, ITEM_KEYS, `items[${index}]`);
	const id = assertVerifyName(text(value.id, `items[${index}].id`, 64), "item");
	const item: VerifyItem = {
		id,
		title: text(value.title, `items[${index}].title`, 120),
		owner: text(value.owner, `items[${index}].owner`, 120),
		beforeUrl: assertLoopbackUrl(text(value.beforeUrl, `items[${index}].beforeUrl`, 2000), `${id} beforeUrl`),
		afterUrl: assertLoopbackUrl(text(value.afterUrl, `items[${index}].afterUrl`, 2000), `${id} afterUrl`),
		menuSelector: value.menuSelector === undefined
			? DEFAULT_MENU
			: text(value.menuSelector, `items[${index}].menuSelector`, 200),
		roles: [],
	};
	const target = optionalText(value.targetUrl, `items[${index}].targetUrl`, 2000);
	if (target) item.targetUrl = assertLoopbackUrl(target, `${id} targetUrl`);
	const route = optionalText(value.route, `items[${index}].route`, 200);
	if (route) item.route = route;
	const beforeRef = optionalText(value.beforeRef, `items[${index}].beforeRef`, 200);
	if (beforeRef) item.beforeRef = beforeRef;
	const afterRef = optionalText(value.afterRef, `items[${index}].afterRef`, 200);
	if (afterRef) item.afterRef = afterRef;
	if (!Array.isArray(value.roles) || value.roles.length === 0)
		throw new Error(`items[${index}].roles must list at least one role`);
	item.roles = value.roles.map((role, roleIndex) => parseRole(role, roleIndex));
	const seen = new Set<string>();
	for (const role of item.roles) {
		if (seen.has(role.id)) throw new Error(`duplicate role ${JSON.stringify(role.id)}`);
		seen.add(role.id);
	}
	const tests = parseTests(value.tests, `items[${index}].tests`);
	if (tests) item.tests = tests;
	return item;
}

/** Parse a verify manifest and reject anything that is not a local seed review. */
export function parseManifest(raw: unknown, expectedName?: string): VerifyManifest {
	if (!isRecord(raw)) throw new Error("manifest must be an object");
	unknownKey(raw, TOP_KEYS, "manifest");
	const name = assertVerifyName(text(raw.name, "name", 64));
	if (expectedName !== undefined && name !== expectedName)
		throw new Error(`manifest name ${JSON.stringify(name)} does not match ${JSON.stringify(expectedName)}`);
	if (!Array.isArray(raw.items) || raw.items.length === 0)
		throw new Error("manifest items must list at least one item");
	const items = raw.items.map((item, index) => parseItem(item, index));
	const seen = new Set<string>();
	for (const item of items) {
		if (seen.has(item.id)) throw new Error(`duplicate item ${JSON.stringify(item.id)}`);
		seen.add(item.id);
	}
	const manifest: VerifyManifest = {
		name,
		stackUrl: assertLoopbackUrl(text(raw.stackUrl, "stackUrl", 2000), "stackUrl"),
		items,
	};
	const tests = parseTests(raw.tests, "tests");
	if (tests) manifest.tests = tests;
	return manifest;
}
