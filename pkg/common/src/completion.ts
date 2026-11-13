import type { Argument, Command, Option } from "commander";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** The line `__complete` prints first when the shell should complete file paths. */
export const FILES_DIRECTIVE = ":files";

export type CompletionOption = {
	flags: string[];
	description?: string;
	value?: "path" | "any" | string[];
	mode?: CompletionNode;
};

export type CompletionNode = {
	name: string;
	description?: string;
	commands?: CompletionNode[];
	options?: CompletionOption[];
	values?: string[];
	path?: boolean;
};

const HELP: CompletionOption = { flags: ["--help"], description: "show help" };
const PATH_WORD = /path|file|dir|folder/i;

export const oneLine = (text: string | undefined): string | undefined => {
	const line = text?.replace(/\s+/g, " ").trim();
	return line ? line : undefined;
};

const candidate = (value: string, description?: string): string =>
	description ? `${value}\t${description}` : value;

function findOption(stack: readonly CompletionNode[], flag: string): CompletionOption | undefined {
	for (const node of [...stack].reverse()) {
		const found = node.options?.find((option) => option.flags.includes(flag));
		if (found) return found;
	}
	return undefined;
}

function valueCandidates(option: CompletionOption, current: string, prefix = ""): string[] {
	if (option.value === "path") return [FILES_DIRECTIVE];
	if (!Array.isArray(option.value)) return [];
	return option.value.filter((value) => value.startsWith(current)).map((value) => `${prefix}${value}`);
}

function optionCandidates(stack: readonly CompletionNode[], current: string): string[] {
	const seen = new Set<string>();
	const options = [...stack].reverse().flatMap((node) => node.options ?? []);
	return [...options, HELP].flatMap((option) => {
		const long = option.flags.find((flag) => flag.startsWith("--") && flag.startsWith(current));
		if (!long || seen.has(long)) return [];
		seen.add(long);
		return [candidate(long, option.description)];
	});
}

/** Candidate lines for the last word of `words`, the words after the program name. */
export function completeWords(root: CompletionNode, words: readonly string[]): string[] {
	const current = words.at(-1) ?? "";
	const stack: CompletionNode[] = [root];
	let pending: CompletionOption | undefined;
	let positional = false;
	for (const word of words.slice(0, -1)) {
		const node = stack.at(-1) as CompletionNode;
		if (pending) {
			pending = undefined;
			continue;
		}
		if (word === "--") {
			positional = true;
			continue;
		}
		if (!positional && word.startsWith("-") && word.length > 1) {
			const [flag = word, inline] = word.split("=", 2);
			const option = findOption(stack, flag);
			if (option?.mode) stack.push(option.mode);
			else if (option?.value && inline === undefined) pending = option;
			continue;
		}
		const child = positional ? undefined : node.commands?.find((command) => command.name === word);
		if (child) stack.push(child);
		else positional = true;
	}
	const node = stack.at(-1) as CompletionNode;
	if (pending) return valueCandidates(pending, current);
	if (!positional && current.startsWith("-")) {
		const eq = current.indexOf("=");
		if (eq > 0) {
			const option = findOption(stack, current.slice(0, eq));
			return option?.value ? valueCandidates(option, current.slice(eq + 1), current.slice(0, eq + 1)) : [];
		}
		return optionCandidates(stack, current);
	}
	if (!positional && node.commands?.length)
		return node.commands
			.filter((command) => command.name.startsWith(current))
			.map((command) => candidate(command.name, command.description));
	if (node.values) return node.values.filter((value) => value.startsWith(current));
	return node.path ? [FILES_DIRECTIVE] : [];
}

type Walked = Command & { _hidden?: boolean; registeredArguments: readonly Argument[] };

function placeholder(option: Option): string {
	return /[<[]([^>\]]+)[>\]]/.exec(option.flags)?.[1] ?? "";
}

function optionOf(option: Option): CompletionOption | undefined {
	if (option.hidden) return undefined;
	const flags = [option.long, option.short].filter((flag): flag is string => !!flag);
	const takesValue = option.required || option.optional;
	const value = !takesValue
		? undefined
		: option.argChoices?.length
			? [...option.argChoices]
			: PATH_WORD.test(placeholder(option))
				? "path"
				: "any";
	return { flags, description: oneLine(option.description), ...(value ? { value } : {}) };
}

/** A completion tree read from a built Commander program. */
export function treeOf(command: Command): CompletionNode {
	const walked = command as Walked;
	const commands = walked.commands
		.filter((child) => !(child as Walked)._hidden && child.name() !== "help")
		.map(treeOf);
	const options = walked.options.flatMap((option) => optionOf(option) ?? []);
	const first = walked.registeredArguments[0];
	const values = first?.argChoices?.length ? [...first.argChoices] : undefined;
	const path = walked.registeredArguments.some((argument) => PATH_WORD.test(argument.name()));
	return {
		name: command.name(),
		...(oneLine(command.description()) ? { description: oneLine(command.description()) } : {}),
		...(commands.length ? { commands } : {}),
		...(options.length ? { options } : {}),
		...(values ? { values } : {}),
		...(path ? { path } : {}),
	};
}

const functionName = (program: string): string => `_${program.replace(/[^A-Za-z0-9]/g, "_")}`;

function bashScript(program: string): string {
	const fn = functionName(program);
	return `${fn}() {
	local cur="\${COMP_WORDS[COMP_CWORD]}" IFS=$'\\n' tab=$'\\t'
	local -a lines
	lines=($(${program} __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
	if [[ "\${lines[0]}" == "${FILES_DIRECTIVE}" ]]; then
		compopt -o filenames 2>/dev/null
		COMPREPLY=($(compgen -f -- "$cur"))
		return 0
	fi
	COMPREPLY=($(printf '%s\\n' "\${lines[@]%%\${tab}*}"))
}
complete -F ${fn} ${program}
`;
}

function zshScript(program: string): string {
	const fn = `_${program}`;
	return `#compdef ${program}
${fn}() {
	local -a lines values displays
	local line tab=$'\\t'
	lines=("\${(@f)$(${program} __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
	if [[ "\${lines[1]}" == "${FILES_DIRECTIVE}" ]]; then
		_files
		return
	fi
	for line in "\${lines[@]}"; do
		[[ -n "$line" ]] || continue
		values+=("\${line%%\${tab}*}")
		if [[ "$line" == *\${tab}* ]]; then
			displays+=("\${line%%\${tab}*} -- \${line#*\${tab}}")
		else
			displays+=("$line")
		fi
	done
	(( \${#values} )) && compadd -l -d displays -a values
}
if [[ "\${funcstack[1]}" == "${fn}" ]]; then
	${fn} "$@"
else
	compdef ${fn} ${program}
fi
`;
}

function fishScript(program: string): string {
	const fn = `_${functionName(program)}`;
	return `function ${fn}
	set -l words (commandline -opc) (commandline -ct)
	set -e words[1]
	set -l lines (${program} __complete $words 2>/dev/null)
	if test "$lines[1]" = "${FILES_DIRECTIVE}"
		__fish_complete_path (commandline -ct)
		return
	end
	printf '%s\\n' $lines
end
complete -c ${program} -f -a '(${fn})'
`;
}

/** The completion script `shell` loads for `program`; it calls `program __complete` for words. */
export function completionScript(shell: CompletionShell, program: string): string {
	if (shell === "bash") return bashScript(program);
	if (shell === "zsh") return zshScript(program);
	return fishScript(program);
}

/** Writes the candidates for `__complete` to stdout; the fast path each program runs before Commander loads. */
export function printCompletions(root: CompletionNode, words: readonly string[]): number {
	const lines = completeWords(root, words);
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

/** Registers `completion <shell>`, which prints the script for this program. */
export function registerCompletionCommand(program: Command): void {
	program
		.command("completion")
		.description("print the bash, zsh or fish completion script for this program")
		.addArgument(program.createArgument("<shell>", "bash, zsh or fish").choices(COMPLETION_SHELLS))
		.action((shell: CompletionShell) => {
			process.stdout.write(completionScript(shell, program.name()));
		});
}
