export interface CommandHelp {
	usage: string;
	summary: string;
}

export const COMMANDS: readonly CommandHelp[] = [
	{
		usage: "ssms <provider> link [--name NAME]",
		summary: "Show link status. signal prints a QR for a linked device named dg-cli.",
	},
	{
		usage: "ssms <provider> status",
		summary: "Report whether the provider account is linked.",
	},
	{
		usage: "ssms <provider> list [--config PATH]",
		summary: "List conversations. google stops at the config scope.",
	},
	{
		usage: "ssms <provider> read <conversation> [--limit N]",
		summary: "Read the newest messages in one conversation.",
	},
	{
		usage: "ssms <provider> receive [--limit N] [--timeout-ms N] [--conversation ID]",
		summary: "Pull new messages. Timeouts use irregular gaps, not a fixed pace.",
	},
	{
		usage: "ssms <provider> watch [--limit N] [--timeout-ms N]",
		summary: "Alias of receive. The default watch budget is 60000 ms.",
	},
	{
		usage: "ssms google archive <conversation> [--dry-run] [--config PATH]",
		summary: "Archive one conversation. Never deletes.",
	},
	{
		usage: "ssms google block-report <conversation> [--dry-run] [--config PATH]",
		summary: "Block and report spam for one conversation.",
	},
	{
		usage: "ssms <provider> draft --conversation ID [--text TEXT] [--emoji EMOJI] [--attachment PATH] [--quote-timestamp N]",
		summary: "Write a pending draft and print it. Does not send.",
	},
	{
		usage: "ssms <provider> send --draft ID [--approve TOKEN]",
		summary: "Send one draft after an interactive yes, or --approve TOKEN. --yes does not send.",
	},
	{
		usage: "ssms google classify [--config PATH]",
		summary: "Classify conversations. Keep rules win. Ambiguous items are not changed.",
	},
	{
		usage: "ssms google cleanup [--dry-run] [--config PATH]",
		summary: "Archive and block only clear-cut conversations. Never deletes or sends.",
	},
];

export const PROVIDER_NAMES = ["google", "signal"] as const;

export function renderHelp(): string {
	const lines = [
		"Usage: ssms <provider> <verb> [options]",
		"",
		"Providers: google, signal",
		"",
		"google drives Messages for Web through the browser CDP harness.",
		"signal wraps signal-cli in daemon JSON-RPC mode. It does not touch Signal Desktop.",
		"",
		"Commands:",
		...COMMANDS.map((item) => `  ${item.usage}`,),
		"",
		"Options:",
		"  --help                 Show this help",
		"  --json                 Print one JSON object on stdout",
		"  --config PATH          Cleanup config (YAML or JSON). Defaults match the skill.",
		"  --dry-run              Report the action and do not change the account",
		"  --yes                  Ignored. It does not approve a send",
		"  --approve TOKEN        Approval token shown on the terminal for that draft",
		"  --name NAME            Linked device name (default dg-cli)",
		"  --limit N              Maximum messages (default 20)",
		"  --timeout-ms N         Receive budget in milliseconds (default 0, watch 60000)",
		"  --conversation ID      Conversation id",
		"  --text TEXT            Draft text",
		"  --emoji EMOJI          Reaction emoji",
		"  --target-timestamp N   Message timestamp a reaction points at",
		"  --target-author ID     Author id a reaction points at",
		"  --attachment PATH      Image or file to attach. Repeat for more than one.",
		"  --quote-timestamp N    Quoted message timestamp",
		"  --quote-author ID      Quoted message author id",
		"  --quote-text TEXT      Quoted message text",
		"  --draft ID             Draft to send",
		"  --remove               Remove a reaction instead of adding one",
		"",
		"Sends go through draft, then an interactive yes or --approve TOKEN.",
		"The token is shown on the terminal device only. It is not printed on stdout.",
		"--yes never sends. allow_send is read from the passwd home (getent, /etc/passwd, or id -P), not from HOME or DG_HOME.",
		"An unresolved passwd home does not send. google.send_enabled defaults to false.",
		"The gate blocks accidental and non-interactive sends. Same-user code that evades it, for example by allocating its own pty, is out of scope.",
		"Logs record ids and reasons only.",
	];
	return `${lines.join("\n")}\n`;
}
