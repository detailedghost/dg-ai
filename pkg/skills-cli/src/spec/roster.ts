import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { qualifiedAgent } from "../proxy/packaged-personas";
import { die, isDirectory, isFile, readText, records, say } from "./shared";

function agentsDir(): string {
	const explicit = process.env.AGENTS_DIR;
	if (explicit) return explicit;
	const home = process.env.HOME ?? homedir();
	const codexHome = process.env.CODEX_HOME;
	if (codexHome && isDirectory(`${codexHome}/agents`))
		return `${codexHome}/agents`;
	for (const candidate of [`${home}/.codex/agents`, `${home}/.claude/agents`])
		if (isDirectory(candidate)) return candidate;
	return die(
		"agents dir not found; checked AGENTS_DIR, CODEX_HOME/agents, ~/.codex/agents, ~/.claude/agents",
	);
}

const trim = (text: string): string => text.replace(/^\s+|\s+$/g, "");

function joinWords(current: string, word: string): string {
	return current === "" ? word : `${current} ${word}`;
}

function markdownRow(name: string, lines: string[], full: boolean): string {
	let inFront = false;
	let doneFront = false;
	let inBlock = false;
	let description = "";
	let paragraph = "";
	for (const [index, line] of lines.entries()) {
		if (index === 0 && line === "---") {
			inFront = true;
			continue;
		}
		if (inFront && line === "---") {
			inFront = false;
			doneFront = true;
			continue;
		}
		if (inFront) {
			if (inBlock) {
				if (/^\s/.test(line)) {
					description = joinWords(description, line.replace(/^\s+/, ""));
					continue;
				}
				inBlock = false;
			}
			if (/^description:\s*/.test(line)) {
				const value = line.replace(/^description:\s*/, "");
				if (/^[|>][-+0-9]*\s*$/.test(value)) {
					inBlock = true;
					description = "";
				} else description = value;
			}
			continue;
		}
		if (doneFront && full) {
			if (/^\s*$/.test(line)) {
				if (paragraph !== "") break;
			} else paragraph = joinWords(paragraph, line);
		}
	}
	return `${name}\t${description}${full && paragraph !== "" ? `\t${paragraph}` : ""}\n`;
}

function unquote(raw: string): string {
	let value = trim(raw);
	if (value.startsWith('"""'))
		return value.replace(/^"""/, "").replace(/"""\s*$/, "");
	if (/^"/.test(value) && /"\s*$/.test(value))
		value = value.replace(/^"/, "").replace(/"\s*$/, "");
	else if (/^'/.test(value) && /'\s*$/.test(value))
		value = value.replace(/^'/, "").replace(/'\s*$/, "");
	return value;
}

function tomlRow(fallback: string, lines: string[], full: boolean): string {
	let name = fallback;
	let description = "";
	let paragraph = "";
	let inDescription = false;
	let inInstructions = false;
	let paragraphDone = false;
	const addDescription = (text: string) => {
		const line = trim(text);
		if (line !== "") description = joinWords(description, line);
	};
	const addParagraph = (text: string) => {
		const line = trim(text);
		if (line === "") {
			if (paragraph !== "") paragraphDone = true;
			return;
		}
		if (!paragraphDone) paragraph = joinWords(paragraph, line);
	};
	const assignedValue = (line: string) => line.replace(/^[^=]*=\s*/, "");
	for (const line of lines) {
		if (inDescription) {
			if (line.includes('"""')) {
				addDescription(line.replace(/""".*$/, ""));
				inDescription = false;
			} else addDescription(line);
		} else if (inInstructions) {
			if (line.includes('"""')) {
				const rest = line.replace(/""".*$/, "");
				if (full && rest !== "") addParagraph(rest);
				inInstructions = false;
			} else if (full) addParagraph(line);
		} else if (/^\s*name\s*=/.test(line)) name = unquote(assignedValue(line));
		else if (/^\s*description\s*=/.test(line)) {
			const value = assignedValue(line);
			if (value.startsWith('"""') && !/"""\s*$/.test(value)) {
				addDescription(value.replace(/^"""/, ""));
				inDescription = true;
			} else description = unquote(value);
		} else if (/^\s*developer_instructions\s*=/.test(line)) {
			let value = assignedValue(line);
			if (value.startsWith('"""')) {
				value = value.replace(/^"""/, "");
				if (/"""\s*$/.test(value)) {
					if (full) addParagraph(value.replace(/"""\s*$/, ""));
				} else {
					if (full && value !== "") addParagraph(value);
					inInstructions = true;
				}
			}
		}
	}
	return `${name}\t${description}${full && paragraph !== "" ? `\t${paragraph}` : ""}\n`;
}

export async function rosterCommand(args: string[]): Promise<number> {
	const full = args[0] === "--full";
	const dir = agentsDir();
	if (!isDirectory(dir)) die(`agents dir not found: ${dir}`);
	const names = readdirSync(dir)
		.filter((name) => !name.startsWith(".") && isFile(`${dir}/${name}`))
		.sort();
	const files = [
		...names.filter((name) => name.endsWith(".toml")),
		...names.filter((name) => name.endsWith(".md")),
	];
	if (files.length === 0) die(`no .toml or .md agent files found in: ${dir}`);
	for (const file of files) {
		const lines = records(await readText(`${dir}/${file}`));
		const row = file.endsWith(".toml")
			? tomlRow(file.slice(0, -5), lines, full)
			: markdownRow(file.slice(0, -3), lines, full);
		const tab = row.indexOf("\t");
		say(`${qualifiedAgent(row.slice(0, tab))}${row.slice(tab)}`);
	}
	return 0;
}
