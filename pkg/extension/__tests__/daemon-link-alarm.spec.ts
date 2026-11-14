import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	type FakeSocket,
	installDaemonHealthStub,
	makeFakeSocket,
	makeStorage,
	makeLocalArea,
	settle,
} from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const { registerDaemonLink } = await import("@/lib/background");

const ALARM_NAME = "dg-link-retry";

beforeEach(() => {
	installDaemonHealthStub();
});

afterEach(() => {
	mock.restore();
});

function bootLink() {
	const sockets: FakeSocket[] = [];
	let onAlarm: ((alarm: { name: string }) => void) | undefined;
	const alarms = {
		create: mock((_name: string, _info: { periodInMinutes: number }) => undefined),
		clear: mock((_name: string) => Promise.resolve(true)),
		onAlarm: {
			addListener: mock((cb: (alarm: { name: string }) => void) => {
				onAlarm = cb;
			}),
		},
	};
	const api = {
		runtime: {
			onMessage: { addListener: mock(() => undefined) },
			getURL: mock((path: string) => `chrome-extension://test-ext/${path}`),
			sendMessage: mock(() => Promise.resolve(undefined)),
		},
		tabGroups: { onUpdated: { addListener: () => undefined, removeListener: () => undefined } },
		tabs: { create: mock(() => Promise.resolve()), onUpdated: { addListener: () => undefined, removeListener: () => undefined }, onRemoved: { addListener: () => undefined, removeListener: () => undefined } },
		storage: makeStorage(makeLocalArea()),
		alarms,
	};
	registerDaemonLink({
		browserApi: api as never,
		openSocket: () => {
			const socket = makeFakeSocket();
			sockets.push(socket);
			return socket;
		},
	});
	return { sockets, alarms, fire: (name = ALARM_NAME) => onAlarm?.({ name }) };
}

test("arms a 30 second alarm while no link socket is admitted", async () => {
	const { alarms } = bootLink();
	await settle();

	expect(alarms.create).toHaveBeenCalledWith(ALARM_NAME, {
		periodInMinutes: 0.5,
	});
});

test("clears the alarm once the link is admitted", async () => {
	const { sockets, alarms } = bootLink();
	await settle();

	sockets[0]?.dispatch("open");
	await settle();

	expect(alarms.clear).toHaveBeenCalledWith(ALARM_NAME);
});

test("arms the alarm again when the link drops", async () => {
	const { sockets, alarms } = bootLink();
	await settle();
	sockets[0]?.dispatch("open");
	await settle();
	alarms.create.mockClear();

	sockets[0]?.dispatch("close");
	await settle();

	expect(alarms.create).toHaveBeenCalledWith(ALARM_NAME, {
		periodInMinutes: 0.5,
	});
});

test("retries the link open when the alarm fires while disconnected", async () => {
	const { sockets, fire } = bootLink();
	await settle();
	const before = sockets.length;

	fire();
	await settle();

	expect(sockets.length).toBe(before + 1);
});

test("ignores an alarm with another name and an alarm that fires while connected", async () => {
	const { sockets, fire } = bootLink();
	await settle();
	sockets[0]?.dispatch("open");
	await settle();
	const before = sockets.length;

	fire("other");
	fire();
	await settle();

	expect(sockets.length).toBe(before);
});
