import { DgCliError } from "@dg/common";
import type { Command } from "commander";
import type { AcceptOpts } from "./accept-name";
import type * as Commands from "./commands";
import { DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS } from "./push";

export const DEFAULT_INVITE_HOURS = 24;
export const WATCH_DEFAULT_FOR_S = 120;

export type PhoneApi = Pick<
	typeof Commands,
	| "phoneNumber"
	| "phoneInvite"
	| "phoneAccept"
	| "phoneContacts"
	| "phoneContactsRename"
	| "phoneContactsRemove"
	| "phoneFiles"
	| "phoneSay"
	| "phoneInbox"
	| "phoneVoicemail"
	| "phoneWatch"
	| "phoneStatus"
	| "phoneOpen"
	| "phoneClose"
	| "phoneRefresh"
	| "phoneRollbackHome"
	| "phoneRun"
	| "phoneThreadNew"
	| "phoneThreadList"
	| "phoneThreadShow"
> & {
	ignoreHangup(): void;
	deps(session?: string): Commands.PhoneDeps;
	openCloseDeps(session?: string): Commands.OpenCloseDeps;
	runDeps(session?: string): Commands.RunDeps;
};

const EXIT_REMOVED_VERB = 2;

/** `phone-friend`'s old verbs that have no new equivalent: each fails outright, naming its replacement. */
const REMOVED_VERBS: Record<string, string> = {
	answer: "answer is gone; run phone open to start the listener, then phone voicemail to read what came in",
	deliver: "deliver is gone; use phone open --on-message to run a program for each message",
	whoami: "whoami is gone; use phone number --as <name>",
	name: "name is gone; use phone contacts rename +old <new>",
};

type PhoneLoader = () => Promise<PhoneApi>;

/** Attaches every phone verb to `group`, plus the hidden one-to-one synonyms `dial`/`on`/`off`/`card` and the removed verbs that fail outright. */
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

	group
		.command("say")
		.description("send one message to a contact, or to a #thread")
		.argument("<handle>", "the contact's +handle, or a #thread")
		.argument("[text]", "message text, or - to read it from stdin; omit with --image")
		.option("--image <path>", "send one PNG, JPEG, or WebP image instead of text")
		.option("--phi", "mark the image as PHI: tags it and keeps the outbox copy 24 hours, not 7 days")
		.action(async (handle: string, text: string | undefined, opts: Commands.SayOpts) => {
			const phone = await load();
			await phone.phoneSay(handle, text, phone.deps(getSession()), opts);
		});

	group
		.command("files")
		.description("print whether say --image may send, or turn it on or off")
		.argument("[state]", "on or off")
		.action(async (state: string | undefined) => {
			const phone = await load();
			phone.phoneFiles(state, phone.deps(getSession()));
		});

	const threads = group.command("thread").description("a static multi-party room with a #handle");

	threads
		.command("new")
		.description("create a thread from existing contacts")
		.argument("<handle>", "thread handle, starting with #")
		.argument("<members...>", "contacts to include, each a +handle")
		.option("--subject <text>", "subject stored on the thread and sent with each message")
		.action(async (handle: string, members: string[], opts: { subject?: string }) => {
			const phone = await load();
			await phone.phoneThreadNew(handle, members, opts, phone.deps(getSession()));
		});

	threads
		.command("list")
		.description("list threads, in handle order")
		.action(async () => {
			const phone = await load();
			phone.phoneThreadList(phone.deps(getSession()));
		});

	threads
		.command("show")
		.description("show one thread and its members")
		.argument("<handle>", "the thread handle")
		.action(async (handle: string) => {
			const phone = await load();
			phone.phoneThreadShow(handle, phone.deps(getSession()));
		});

	group
		.command("inbox")
		.description("print stored messages, oldest first; never marks anything read")
		.option("-n, --count <count>", "how many messages to print", "50")
		.option("--meta", "print metadata only, omitting message text")
		.argument("[handle]", "limit to one contact's messages")
		.action(async (handle: string | undefined, opts: { count?: string; meta?: boolean }) => {
			const phone = await load();
			phone.phoneInbox({ n: opts.count, handle, meta: opts.meta }, phone.deps(getSession()));
		});

	group
		.command("voicemail")
		.description("print unread messages, oldest first, and mark them read")
		.action(async () => {
			const phone = await load();
			await phone.phoneVoicemail(phone.deps(getSession()));
		});

	group
		.command("watch")
		.description("print unread voicemail until --for seconds elapse, waiting a jittered gap between checks")
		.option("--for <seconds>", "seconds to keep checking", String(WATCH_DEFAULT_FOR_S))
		.option("--new", "print only messages that arrive after watch starts; the default also prints the unread backlog")
		.action(async (opts: { for?: string; new?: boolean }) => {
			const phone = await load();
			await phone.phoneWatch(opts, phone.deps(getSession()));
		});

	group
		.command("status")
		.description("print your self name, contact count, and pending voicemail count")
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
		.hook("preAction", (hooked, action) => {
			({ session } = action.optsWithGlobals<{ session?: string }>());
			if (hooked.getOptionValueSource("line") === "cli") {
				throw new DgCliError("--line is gone: one phone holds every contact; use +handle on say and inbox", EXIT_REMOVED_VERB);
			}
		});
	attachPhoneVerbs(group, load, () => session);
}

export function registerLazyPhoneCommands(program: Command): void {
	registerPhoneGroup(program, async () => (await import("./commands")).defaultPhoneApi);
}
