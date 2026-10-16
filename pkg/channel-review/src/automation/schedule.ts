import { SCHEDULE_DAYS, type Schedule } from "../config";

export type DueWindow = { windowStart: Date; windowEnd: Date };

export function resolveSchedule(base: Schedule, own: Partial<Schedule>): Schedule {
	return {
		every: own.every ?? base.every,
		day: own.day ?? base.day,
		window: own.window ?? base.window,
	};
}

function minutesOf(time: string): [number, number] {
	const [hours = 0, minutes = 0] = time.split(":").map(Number);
	return [hours, minutes];
}

export function dueWindow(now: Date, schedule: Schedule): DueWindow | null {
	const [from, to] = schedule.window.split("-");
	const [startHour, startMinute] = minutesOf(from ?? "");
	const [endHour, endMinute] = minutesOf(to ?? "");
	const crossesMidnight = endHour * 60 + endMinute <= startHour * 60 + startMinute;

	for (const offset of [0, -1]) {
		const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
		if (schedule.every === "week" && SCHEDULE_DAYS[(day.getDay() + 6) % 7] !== schedule.day) {
			continue;
		}
		const windowStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, startMinute);
		const windowEnd = new Date(
			day.getFullYear(),
			day.getMonth(),
			day.getDate() + (crossesMidnight ? 1 : 0),
			endHour,
			endMinute,
		);
		if (windowStart <= now && now < windowEnd) return { windowStart, windowEnd };
	}
	return null;
}
