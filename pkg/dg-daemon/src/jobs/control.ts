import type {
	ServiceAction,
	ServiceStatus,
	Supervisor,
} from "../services/supervisor";

export type JobControl = {
	start(name: string): ServiceAction;
	stop(name: string): Promise<ServiceAction>;
	status(): ServiceStatus[];
};

export const createJobControl = (supervisor: Supervisor): JobControl => ({
	start: (name) => supervisor.start(name),
	stop: (name) => supervisor.stop(name),
	status: () => supervisor.status(),
});
