import { DgCliError } from "@dg/common";
import type { Command } from "commander";
import type { AcceptOpts } from "./accept-name";
import type * as Commands from "./commands";
import { DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS } from "./push";

export const DEFAULT_INVITE_HOURS = 24;
export const WATCH_DEFAULT_FOR_S = 120;
export const ALIAS_REMOVAL_VERSION = "1.43.0";

export type PhoneApi = Pick<
	typeof Commands,
	| "phoneNumber"
	| "phoneInvite"
	| "phoneAccept"
	| "phoneContacts"
	| "phoneContactsRename"
	| "phoneContactsRemove"
	| "phoneFiles"
	| "phonePresence"
	| "phoneSay"
	| "phonePing"
	| "phoneInbox"
	| "phoneVoicemail"
	| "phoneWatch"
	| "phoneStatus"
	| "phoneOpen"
	| "phoneClose"
	| "phoneRefresh"
	| "moveLegacyPhoneHome"
	| "phoneRollbackHome"
	| "phoneRun"
	| "phoneThreadNew"
	| "phoneThreadList"
	| "phoneThreadShow"
	| "phoneVaultAdd"
	| "phoneVaultList"
	| "phoneVaultRm"
	| "phoneVaultOpen"
	| "phoneVaultExec"
> & {
	ignoreHangup(): void;
	deps(session?: string): Commands.PhoneDeps;
	openCloseDeps(session?: string): Commands.OpenCloseDeps;
	runDeps(session?: string): Commands.RunDeps;
};

const EXIT_REMOVED_VERB = 2;

const OWNS_HOME_MOVE = new Set(["__refresh", "__rollback-home", "__run"]);
const MANAGES_LISTENER = new Set(["close", "off"]);

/** `phone-friend`'s old verbs that have no new equivalent: each fails outright, naming its replacement. */
const REMOVED_VERBS: Record<string, string> = {
	answer: "answer is gone; run phone open to start the listener, then phone unread to read what came in",
	deliver: "deliver is gone; use phone open --on-message to run a program for each message",
	whoami: "whoami is gone; use phone number --as <name>",
	name: "name is gone; use phone contacts rename +old <new>",
};

/** A hidden command that stands in for a renamed one and prints one stderr notice before it runs. */
function renamedAlias(group: Command, oldName: string, newName: string): Command {
	return group
		.command(oldName, { hidden: true })
		.hook("preAction", () => {
			process.stderr.write(`phone ${oldName} is now phone ${newName}; this alias goes away in ${ALIAS_REMOVAL_VERSION}\n`);
		});
}

type PhoneLoader = () => Promise<PhoneApi>;

/** Attaches every phone verb to `group`, plus the hidden renamed-verb aliases, the one-to-one synonyms `dial`/`on`/`off`/`card` and the removed verbs that fail outright. */
function attachPhoneVerbs(group: Command, load: PhoneLoader, getSession: () => string | undefined): void {
	group
		.command("number")
		.description("print your number card, with your npub, relays, and listener state")
		.option("--as <name>", "self name your card carries, saved for next time")
		.option("--rotate", "roll a new secret, so every card printed before this stops admitting")
		.option("--relay <url...>", "relays your own card should use from now on")
		.action(async (opts: { as?: string; rotate?: boolean; relay?: string[] }) => {
			const phone = await load();
			await phone.phoneNumber(opts, phone.deps(getSession()));
		});

	group
		.command("invite")
		.description("make a one-time call card; the first ring it admits becomes a new contact")
		.option("--relay <url...>", "relays this card should use instead of the saved ones")
		.option("--ttl <hours>", "hours until the card expires", String(DEFAULT_INVITE_HOURS))
		.option("--as <name>", "self name this card carries instead of your saved one")
		.option("--name <handle>", "handle to give the contact once the call is answered")
		.action(async (opts: { relay?: string[]; ttl?: string; as?: string; name?: string }) => {
			const phone = await load();
			await phone.phoneInvite(opts, phone.deps(getSession()));
		});

	group
		.command("accept")
		.description("accept a call card: ring its owner and save them as a contact")
		.argument("[card]", "the call card, or - to read it from stdin", "-")
		.argument("[text]", "first words to send", "hello")
		.option("--name <handle>", 'handle for a new contact; required when the card self name is missing, "default", or taken')
		.option("--key <id>", "existing key id to sign a new contact with, instead of the number key")
		.action(async (card: string, text: string, opts: AcceptOpts) => {
			const phone = await load();
			await phone.phoneAccept(card, text, phone.deps(getSession()), opts);
		});

	const contacts = group
		.command("contacts")
		.description("list every contact, in handle order")
		.action(async () => {
			const phone = await load();
			phone.phoneContacts(phone.deps(getSession()));
		});

	contacts
		.command("rename")
		.argument("<old>", "the contact's current handle")
		.argument("<new>", "the new handle")
		.action(async (oldHandle: string, newHandle: string) => {
			const phone = await load();
			phone.phoneContactsRename(oldHandle, newHandle, phone.deps(getSession()));
		});

	contacts
		.command("remove")
		.argument("<handle>", "the contact to remove")
		.action(async (handle: string) => {
			const phone = await load();
			phone.phoneContactsRemove(handle, phone.deps(getSession()));
		});

	const sendText = (command: Command): Command =>
		command
			.argument("<handle>", "the contact's +handle, +handle/ext for one agent on their machine, or a #group")
			.argument("[text]", "message text, or - to read it from stdin; omit with --image")
			.option("--as <ext>", "your own extension, sent so replies route back (default DG_PHONE_AS)")
			.option("--image <path>", "send one PNG, JPEG, or WebP image instead of text")
			.option("--phi", "mark the message as PHI: tags it, stores only a placeholder row, and keeps any outbox copy 24 hours, not 7 days")
			.option("--vault <name>", "send a vault item, text or image, without printing it; implies --phi")
			.action(async (handle: string, text: string | undefined, opts: Commands.SayOpts) => {
				const phone = await load();
				await phone.phoneSay(handle, text, phone.deps(getSession()), opts);
			});
	sendText(group.command("text").description("send one message to a contact, or to a #group"));
	sendText(renamedAlias(group, "say", "text"));

	group
		.command("ping")
		.description("check that a contact's or #group's listener answers; exit 1 when no receipt comes in time")
		.argument("<handle>", "the contact's +handle, +handle/ext, or a #group")
		.option("--timeout <seconds>", "seconds to wait for the receipt", "30")
		.action(async (handle: string, opts: { timeout?: string }) => {
			const phone = await load();
			await phone.phonePing(handle, opts, phone.deps(getSession()));
		});

	group
		.command("files")
		.description("print whether text --image may send, or turn it on or off")
		.argument("[state]", "on or off")
		.action(async (state: string | undefined) => {
			const phone = await load();
			phone.phoneFiles(state, phone.deps(getSession()));
		});

	group
		.command("presence")
		.description("print whether beats, receipts, and ping answers go out, or turn them on or off")
		.argument("[state]", "on or off")
		.action(async (state: string | undefined) => {
			const phone = await load();
			phone.phonePresence(state, phone.deps(getSession()));
		});

	const attachGroupVerbs = (parent: Command): void => {
		parent
			.command("new")
			.description("create a group from existing contacts")
			.argument("<handle>", "group handle, starting with #")
			.argument("<members...>", "contacts to include, each a +handle")
			.option("--subject <text>", "subject stored on the group and sent with each message")
			.action(async (handle: string, members: string[], opts: { subject?: string }) => {
				const phone = await load();
				await phone.phoneThreadNew(handle, members, opts, phone.deps(getSession()));
			});

		parent
			.command("list")
			.description("list groups, in handle order")
			.action(async () => {
				const phone = await load();
				phone.phoneThreadList(phone.deps(getSession()));
			});

		parent
			.command("show")
			.description("show one group and its members")
			.argument("<handle>", "the group handle")
			.action(async (handle: string) => {
				const phone = await load();
				phone.phoneThreadShow(handle, phone.deps(getSession()));
			});
	};
	const vault = group.command("vault").description("a store for PHI that agents can use but never read");

	vault
		.command("add")
		.description("seal a file, or stdin, as a vault item; prints the name, size, and dates only")
		.argument("<name>", "item name; names hold no PHI")
		.argument("[file]", "file to read; stdin when omitted")
		.action(async (name: string, file: string | undefined) => {
			const phone = await load();
			await phone.phoneVaultAdd(name, file, phone.deps(getSession()));
		});

	vault
		.command("list")
		.description("list item names, sizes, types, senders, and dates; never content")
		.option("--as <ext>", "list only this extension's items plus the shared ones (default DG_PHONE_AS)")
		.action(async (opts: { as?: string }) => {
			const phone = await load();
			await phone.phoneVaultList(phone.deps(getSession()), opts);
		});

	vault
		.command("rm")
		.description("delete one vault item")
		.argument("<name>", "item name")
		.action(async (name: string) => {
			const phone = await load();
			await phone.phoneVaultRm(name, phone.deps(getSession()));
		});

	vault
		.command("open")
		.description("human only: show an item on this terminal; refuses in an agent session or without a TTY")
		.argument("<name>", "item name")
		.action(async (name: string) => {
			const phone = await load();
			await phone.phoneVaultOpen(name, phone.deps(getSession()));
		});

	vault
		.command("exec")
		.description("run a command with the item on stdin or in one env var; its stdout becomes a new item")
		.argument("<name>", "item name")
		.argument("<cmd...>", "the command and its args, after --")
		.option("--env <var>", "pass a text item under 64 KiB in this env var instead of stdin")
		.option("--stdin", "pass the item on stdin (the default)")
		.option("--out <name>", "name of the new item; never overwrites (default <name>-out)")
		.option("--timeout <seconds>", "seconds before the command is killed; nothing is stored and the exit code is 124", "120")
		.action(async (name: string, argv: string[], opts: Commands.ExecOpts) => {
			const phone = await load();
			await phone.phoneVaultExec(name, argv, opts, phone.deps(getSession()));
		});

	attachGroupVerbs(group.command("group").description("a static multi-party room with a #handle"));
	attachGroupVerbs(renamedAlias(group, "thread", "group"));

	const printMessages = (command: Command): Command =>
		command
			.option("-n, --count <count>", "how many messages to print", "50")
			.option("--meta", "print metadata only, omitting message text")
			.option("--as <ext>", "read as this extension: its messages plus the shared ones (default DG_PHONE_AS)")
			.argument("[handle]", "limit to one contact's messages")
			.action(async (handle: string | undefined, opts: { count?: string; meta?: boolean; as?: string }) => {
				const phone = await load();
				phone.phoneInbox({ n: opts.count, handle, meta: opts.meta, as: opts.as }, phone.deps(getSession()));
			});
	printMessages(group.command("messages").description("print stored messages, oldest first; never marks anything read"));
	printMessages(renamedAlias(group, "inbox", "messages"));

	const printUnread = (command: Command): Command =>
		command.option("--as <ext>", "read as this extension: its messages plus the shared ones (default DG_PHONE_AS)").action(async (opts: { as?: string }) => {
			const phone = await load();
			await phone.phoneVoicemail(phone.deps(getSession()), opts);
		});
	printUnread(group.command("unread").description("print unread messages, oldest first, and mark them read"));
	printUnread(renamedAlias(group, "voicemail", "unread"));

	group
		.command("watch")
		.description("print unread messages until --for seconds elapse, waiting a jittered gap between checks")
		.option("--for <seconds>", "seconds to keep checking", String(WATCH_DEFAULT_FOR_S))
		.option("--new", "print only messages that arrive after watch starts; the default also prints the unread backlog")
		.option("--as <ext>", "read as this extension: its messages plus the shared ones (default DG_PHONE_AS)")
		.action(async (opts: { for?: string; new?: boolean; as?: string }) => {
			const phone = await load();
			await phone.phoneWatch(opts, phone.deps(getSession()));
		});

	group
		.command("status")
		.description("print your self name, contact count, and unread message count")
		.action(async () => {
			const phone = await load();
			await phone.phoneStatus(phone.deps(getSession()));
		});

	const open = async (opts: { onMessage?: string[]; onMessageTimeout?: string; ensure?: boolean; printCron?: boolean; installCron?: boolean }) => {
		const phone = await load();
		await phone.phoneOpen(opts, phone.openCloseDeps(getSession()));
	};
	const close = async () => {
		const phone = await load();
		await phone.phoneClose(phone.openCloseDeps(getSession()));
	};
	const card = async (opts: { as?: string; rotate?: boolean; relay?: string[] }) => {
		const phone = await load();
		await phone.phoneNumber(opts, phone.deps(getSession()));
	};
	const accept = async (cardArg: string, text: string, opts: AcceptOpts) => {
		const phone = await load();
		await phone.phoneAccept(cardArg, text, phone.deps(getSession()), opts);
	};

	group
		.command("open")
		.description("start the listener and install it to start on login, where a service manager exists")
		.option("--on-message <argv...>", "command and args to run for each delivered message, saved for next time")
		.option("--on-message-timeout <seconds>", "seconds before --on-message is killed", String(DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS))
		.option("--ensure", "start a detached listener when the pidfile is not a live copy of this binary; safe to repeat from cron")
		.option("--print-cron", "include a crontab line for --ensure in the output; does not change the crontab")
		.option("--install-cron", "install that crontab line; never implied by --ensure")
		.action(open);

	group
		.command("close")
		.description("stop the listener and remove it from login autostart")
		.action(close);

	group
		.command("__refresh", { hidden: true })
		.description("internal: restart a listener whose binary or keys drifted")
		.action(async () => {
			const phone = await load();
			await phone.phoneRefresh(phone.openCloseDeps(getSession()));
		});

	group
		.command("__rollback-home", { hidden: true })
		.description("internal: copy phone state back to the old phone folder for an older release")
		.action(async () => {
			const phone = await load();
			phone.phoneRollbackHome(phone.deps(getSession()));
		});

	group
		.command("__run", { hidden: true })
		.description("internal: run the always-on listener in the foreground (never call directly)")
		.option("--on-message <argv...>", "command and args to run for each delivered message")
		.option("--on-message-timeout <seconds>", "seconds before --on-message is killed", String(DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS))
		.option("--dg-home <dir>", "state directory for this listener; overrides DG_HOME")
		.action(async (opts: { onMessage?: string[]; onMessageTimeout?: string; dgHome?: string }) => {
			if (opts.dgHome) process.env.DG_HOME = opts.dgHome;
			const phone = await load();
			phone.ignoreHangup();
			await phone.phoneRun(opts, phone.runDeps(getSession()));
		});

	group
		.command("dial", { hidden: true })
		.argument("[card]", "the call card, or - to read it from stdin", "-")
		.argument("[text]", "first words to send", "hello")
		.option("--name <handle>", 'handle for a new contact; required when the card self name is missing, "default", or taken')
		.option("--key <id>", "existing key id to sign a new contact with, instead of the number key")
		.action(accept);

	group
		.command("on", { hidden: true })
		.option("--on-message <argv...>", "command and args to run for each delivered message, saved for next time")
		.option("--on-message-timeout <seconds>", "seconds before --on-message is killed", String(DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS))
		.action(open);

	group
		.command("off", { hidden: true })
		.action(close);

	group
		.command("card", { hidden: true })
		.option("--as <name>", "self name your card carries, saved for next time")
		.option("--rotate", "roll a new secret, so every card printed before this stops admitting")
		.option("--relay <url...>", "relays your own card should use from now on")
		.action(card);

	for (const [verb, message] of Object.entries(REMOVED_VERBS)) {
		group
			.command(verb, { hidden: true })
			.argument("[args...]")
			.action(() => {
				throw new DgCliError(message, EXIT_REMOVED_VERB);
			});
	}
}

export function registerPhoneGroup(program: Command, load: PhoneLoader): void {
	let session: string | undefined;

	const group = program
		.command("phone")
		.description("one phone number, many contacts: private NIP-17 chat over public Nostr relays")
		.option("--line <name>", "removed; one phone holds every contact now")
		.hook("preAction", async (hooked, action) => {
			({ session } = action.optsWithGlobals<{ session?: string }>());
			if (hooked.getOptionValueSource("line") === "cli") {
				throw new DgCliError("--line is gone: one phone holds every contact; use +handle on text and messages", EXIT_REMOVED_VERB);
			}
			if (OWNS_HOME_MOVE.has(action.name())) return;
			const phone = await load();
			const deps = phone.openCloseDeps(session);
			if ((await phone.moveLegacyPhoneHome(deps)) && !MANAGES_LISTENER.has(action.name())) await phone.phoneOpen({}, Object.create(deps, { write: { value: () => {} } }));
		});
	attachPhoneVerbs(group, load, () => session);
}

export function registerLazyPhoneCommands(program: Command): void {
	registerPhoneGroup(program, async () => (await import("./commands")).defaultPhoneApi);
}
