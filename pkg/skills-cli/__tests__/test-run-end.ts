const tasks: (() => void)[] = [];

/** Bun skips process exit hooks under `bun test`, so shared fixtures register cleanup here for the preload's afterAll. */
export function onTestRunEnd(task: () => void): void {
	tasks.push(task);
}

export function runTestRunEndTasks(): void {
	for (const task of tasks.splice(0)) task();
}
