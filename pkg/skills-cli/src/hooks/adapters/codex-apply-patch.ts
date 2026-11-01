import { isAbsolute, join } from "node:path";
import type { HookInput } from "../types";

interface FilePatch {
	path: string;
	added: string[];
}

const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/;

function parsePatch(patch: string): FilePatch[] {
	const files: FilePatch[] = [];
	let current: FilePatch | undefined;
	for (const line of patch.split("\n")) {
		const header = FILE_HEADER.exec(line);
		if (header) {
			current =
				header[1] === "Delete" ? undefined : { path: header[2]!, added: [] };
			if (current) files.push(current);
			continue;
		}
		const move = MOVE_HEADER.exec(line);
		if (move) {
			if (current) current.path = move[1]!;
			continue;
		}
		if (line.startsWith("***") || line.startsWith("@@")) continue;
		if (current && line.startsWith("+")) current.added.push(line.slice(1));
	}
	return files;
}

/** Turns one Codex apply_patch event into one Edit-shaped input per written file. */
export function applyPatchInputs(event: HookInput): HookInput[] {
	if (event.tool_name !== "apply_patch") return [event];
	const patch = event.tool_input?.["command"];
	if (typeof patch !== "string") return [];
	const cwd = event.cwd ?? process.cwd();
	return parsePatch(patch).map((file) => ({
		...event,
		tool_name: "Edit",
		tool_input: {
			file_path: isAbsolute(file.path) ? file.path : join(cwd, file.path),
			new_string: file.added.join("\n"),
		},
	}));
}
