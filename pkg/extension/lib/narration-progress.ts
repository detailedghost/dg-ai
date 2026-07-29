/** Progress allocation for local model loading and per-step narration synthesis. */

export type ModelLoadProgress = {
	status: string;
	name?: string;
	file?: string;
	loaded?: number;
	total?: number;
};

const MODEL_READY_PERCENT = 60;
const SYNTHESIS_READY_PERCENT = 98;

/** Round an untrusted progress number into 0-100, for anything rendering a percentage. */
export function clampPercent(progress: number): number {
	return Math.min(Math.max(Math.round(progress), 0), 100);
}

/** Keep a monotonic overall percentage while several model files load in parallel. */
export class NarrationProgressTracker {
	private readonly files = new Map<string, { loaded: number; total: number }>();
	private percent = 0;

	model(info: ModelLoadProgress): number {
		if (
			info.status !== "progress" ||
			typeof info.loaded !== "number" ||
			typeof info.total !== "number" ||
			info.total <= 0
		)
			return this.percent;

		const key = `${info.name ?? ""}/${info.file ?? ""}`;
		this.files.set(key, {
			loaded: Math.min(Math.max(info.loaded, 0), info.total),
			total: info.total,
		});
		let loaded = 0;
		let total = 0;
		for (const file of this.files.values()) {
			loaded += file.loaded;
			total += file.total;
		}
		return this.bump(
			Math.min(MODEL_READY_PERCENT - 1, Math.round((loaded / total) * 100)),
		);
	}

	modelReady(): number {
		return this.bump(MODEL_READY_PERCENT);
	}

	synthesis(completed: number, total: number): number {
		if (total <= 0) return this.bump(SYNTHESIS_READY_PERCENT);
		const ratio = Math.min(Math.max(completed / total, 0), 1);
		return this.bump(
			MODEL_READY_PERCENT +
				Math.round(ratio * (SYNTHESIS_READY_PERCENT - MODEL_READY_PERCENT)),
		);
	}

	ready(): number {
		return this.bump(100);
	}

	private bump(next: number): number {
		this.percent = Math.max(this.percent, next);
		return this.percent;
	}
}
