import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HookDefinition, SettingsWriter } from "../types";
import { type JsonObject, readJsonObject, updateJsonFile } from "./json-file";
import { ownedCommand, ownedId } from "./marker";

interface HookEntry {
	type?: string;
	command?: string;
	[key: string]: unknown;
}

interface HookGroup {
	matcher?: string;
	hooks: HookEntry[];
	[key: string]: unknown;
}

type HooksMap = Record<string, unknown>;

const isGroup = (value: unknown): value is HookGroup =>
	typeof value === "object" &&
	value !== null &&
	Array.isArray((value as HookGroup).hooks);

function hooksOf(file: string, doc: JsonObject): HooksMap {
	const hooks = doc.hooks;
	if (hooks === undefined) return {};
	if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))
		throw new Error(`${file}: "hooks" must be an object`);
	return hooks as HooksMap;
}

const groupsOf = (hooks: HooksMap, event: string): unknown[] => {
	const groups = Object.hasOwn(hooks, event) ? hooks[event] : undefined;
	return Array.isArray(groups) ? groups : [];
};

const idOf = (entry: HookEntry): string | undefined =>
	typeof entry?.command === "string" ? ownedId(entry.command) : undefined;

function withHook(
	file: string,
	doc: JsonObject,
	def: HookDefinition,
	launcher: string,
): JsonObject {
	const hooks = hooksOf(file, doc);
	if (Object.hasOwn(hooks, def.event) && !Array.isArray(hooks[def.event]))
		throw new Error(`${file}: "hooks.${def.event}" must be an array`);
	const groups = groupsOf(hooks, def.event);
	const command = ownedCommand(launcher, def.id);
	const entry: HookEntry = { type: "command", command };
	let present = false;
	const refreshed = groups.map((g) => {
		if (!isGroup(g) || !g.hooks.some((h) => idOf(h) === def.id)) return g;
		present = true;
		if (g.hooks.every((h) => idOf(h) !== def.id || h.command === command))
			return g;
		return {
			...g,
			hooks: g.hooks.map((h) =>
				idOf(h) === def.id && h.command !== command ? { ...h, command } : h,
			),
		};
	});
	let next = refreshed;
	if (!present) {
		const target = refreshed.find(
			(g) => isGroup(g) && g.matcher === def.matcher,
		) as HookGroup | undefined;
		next = target
			? refreshed.map((g) =>
					g === target ? { ...target, hooks: [...target.hooks, entry] } : g,
				)
			: [
					...refreshed,
					{ ...(def.matcher ? { matcher: def.matcher } : {}), hooks: [entry] },
				];
	}
	return { ...doc, hooks: { ...hooks, [def.event]: next } };
}

function withoutHooks(
	file: string,
	doc: JsonObject,
	ids: readonly string[] | undefined,
	removed: Set<string>,
): JsonObject {
	const source = hooksOf(file, doc);
	const hooks: HooksMap = { ...source };
	for (const event of Object.keys(source)) {
		const groups = groupsOf(source, event);
		let touched = false;
		const kept: unknown[] = [];
		for (const group of groups) {
			if (!isGroup(group)) {
				kept.push(group);
				continue;
			}
			const rest = group.hooks.filter((h) => {
				const id = idOf(h);
				if (id === undefined || (ids && !ids.includes(id))) return true;
				removed.add(id);
				touched = true;
				return false;
			});
			if (rest.length === group.hooks.length) kept.push(group);
			else if (rest.length > 0) kept.push({ ...group, hooks: rest });
		}
		if (!touched) continue;
		if (kept.length > 0) hooks[event] = kept;
		else delete hooks[event];
	}
	if (removed.size === 0) return doc;
	if (Object.keys(hooks).length > 0) return { ...doc, hooks };
	const next: JsonObject = { ...doc };
	delete next.hooks;
	return next;
}

export function hookGroupsWriter(dir: string, file: string): SettingsWriter {
	return {
		dir,
		file,
		check() {
			if (existsSync(file)) hooksOf(file, readJsonObject(file));
		},
		async enable(defs, launcher) {
			await updateJsonFile(file, (doc) =>
				defs.reduce((acc, def) => withHook(file, acc, def, launcher), doc),
			);
			return defs.map((d) => d.id);
		},
		async disable(ids) {
			if (!existsSync(file)) return [];
			let removed = new Set<string>();
			await updateJsonFile(file, (doc) => {
				removed = new Set();
				return withoutHooks(file, doc, ids, removed);
			});
			return [...removed];
		},
		enabled() {
			const ids = new Set<string>();
			if (!existsSync(file)) return [];
			const hooks = hooksOf(file, readJsonObject(file));
			for (const event of Object.keys(hooks))
				for (const g of groupsOf(hooks, event))
					if (isGroup(g))
						for (const h of g.hooks) {
							const id = idOf(h);
							if (id) ids.add(id);
						}
			return [...ids];
		},
	};
}

export const claudeWriter = (home: string): SettingsWriter =>
	hookGroupsWriter(
		join(home, ".claude"),
		join(home, ".claude", "settings.json"),
	);
