import { describeError } from "@dg/common";
import { Cron } from "croner";

export function nextCronRun(expr: string, from: Date): Date {
	let cron: Cron;
	try {
		cron = new Cron(expr);
	} catch (err) {
		throw new Error(`invalid cron expression "${expr}": ${describeError(err)}`);
	}
	const next = cron.nextRun(from);
	if (!next) {
		throw new Error(
			`cron expression "${expr}" has no run after ${from.toISOString()}`,
		);
	}
	return next;
}
