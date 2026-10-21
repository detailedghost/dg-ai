import { describe, expect, it } from "bun:test";
import { createChannel } from "../src/index";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of source) items.push(item);
	return items;
}

describe("createChannel", () => {
	it("delivers values in FIFO order", async () => {
		const channel = createChannel<number>();
		await channel.send(1);
		await channel.send(2);
		await channel.send(3);
		channel.close();
		expect(await drain(channel)).toEqual([1, 2, 3]);
	});

	it("makes send wait on a full bounded channel until a receive frees room", async () => {
		const channel = createChannel<number>(1);
		await channel.send(1);
		let sent = false;
		const second = channel.send(2).then(() => {
			sent = true;
		});
		await tick();
		expect(sent).toBe(false);
		expect(await channel.receive()).toEqual({ done: false, value: 1 });
		await second;
		expect(sent).toBe(true);
		expect(await channel.receive()).toEqual({ done: false, value: 2 });
	});

	it("drains buffered values after close, then ends iteration", async () => {
		const channel = createChannel<string>();
		await channel.send("a");
		channel.close();
		expect(await channel.receive()).toEqual({ done: false, value: "a" });
		expect(await channel.receive()).toEqual({ done: true, value: undefined });
	});

	it("ends a receive that is waiting when the channel closes", async () => {
		const channel = createChannel<number>();
		const waiting = channel.receive();
		channel.close();
		expect(await waiting).toEqual({ done: true, value: undefined });
	});

	it("rejects send after close and rejects senders waiting at close", async () => {
		const channel = createChannel<number>(1);
		await channel.send(1);
		const blocked = channel.send(2);
		channel.close();
		await expect(blocked).rejects.toThrow("closed channel");
		await expect(channel.send(3)).rejects.toThrow("closed channel");
	});

	it("gives each of many concurrent receivers a distinct item", async () => {
		const channel = createChannel<number>();
		const receivers = [1, 2, 3, 4].map(() => channel.receive());
		for (const value of [10, 20, 30, 40]) await channel.send(value);
		const values = (await Promise.all(receivers)).map((result) => result.value);
		expect(values).toEqual([10, 20, 30, 40]);
	});

	it("shares one stream between concurrent for-await workers without duplicates", async () => {
		const channel = createChannel<number>(2);
		const seen: number[][] = [[], []];
		const workers = seen.map(async (bucket) => {
			for await (const value of channel) {
				bucket.push(value);
				await tick();
			}
		});
		for (let value = 0; value < 8; value += 1) await channel.send(value);
		channel.close();
		await Promise.all(workers);
		expect(seen.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(seen[0].length).toBeGreaterThan(0);
		expect(seen[1].length).toBeGreaterThan(0);
	});
});
