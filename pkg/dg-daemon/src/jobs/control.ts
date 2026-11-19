import type {
	ServiceAction,
	ServiceStatus,
	Supervisor,
} from "../services/supervisor";
import type { JobRunner, ScheduledStatus } from "./runner";

export type JobStatus = ServiceStatus | ScheduledStatus;

export type JobAction =
	| { ok: true; status: JobStatus }
	| Extract<ServiceAction, { ok: false }>;

export type JobControl = {
	start(name: string): JobAction;
	stop(name: string): Promise<JobAction>;
	status(): JobStatus[];
};

export function createJobControl(
	supervisor: Supervisor,
	runner: JobRunner,
): JobControl {
	const supervised = (name: string): boolean =>
		supervisor
			.status()
			.some(
				(row) =>
					row.label === name &&
					(row.state === "running" || row.state === "backoff"),
			);
	const scheduled = (name: string): boolean =>
		runner.knows(name) && !supervised(name);
	return {
		start: (name) =>
			scheduled(name) ? runner.runNow(name) : supervisor.start(name),
		stop: (name) =>
			scheduled(name) ? runner.stop(name) : supervisor.stop(name),
		status: () => {
			const rows = supervisor.status();
			const held = new Set(
				rows
					.filter((row) => row.state === "running" || row.state === "backoff")
					.map((row) => row.label),
			);
			return [
				...rows,
				...runner.status().filter((row) => !held.has(row.label)),
			];
		},
	};
}
