/**
 * Dependency-free celebratory confetti burst. Self-contained (no external libs, CSP-safe):
 * appends a fixed, pointer-transparent <canvas>, animates paper bits, removes itself when done.
 * Used by PrDecisionSection to celebrate an "open"/"draft" PR launch in the picker's green tones.
 * Respects prefers-reduced-motion (renders nothing). Browser-only — safe to use Math.random here.
 */

interface ConfettiOptions {
	count?: number;
	colors?: string[];
	durationMs?: number;
}

interface Particle {
	x: number;
	y: number;
	vx: number;
	vy: number;
	rot: number;
	vr: number;
	size: number;
	color: string;
}

// Greens matching the picker's Open button + approve glow, with a little white for pop.
const GREEN_CONFETTI = ["#2ea043", "#3fb950", "#56d364", "#7ee787", "#d2f4d3", "#ffffff"];

export function burstConfetti(options?: ConfettiOptions): void {
	if (typeof window === "undefined" || typeof document === "undefined") return;
	if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

	const count = options?.count ?? 150;
	const colors = options?.colors ?? GREEN_CONFETTI;
	const duration = options?.durationMs ?? 2600;

	const width = window.innerWidth;
	const height = window.innerHeight;
	const dpr = window.devicePixelRatio || 1;

	const canvas = document.createElement("canvas");
	canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:200";
	canvas.width = Math.floor(width * dpr);
	canvas.height = Math.floor(height * dpr);
	document.body.appendChild(canvas);

	const ctx = canvas.getContext("2d");
	if (!ctx) {
		canvas.remove();
		return;
	}
	// Capture the guarded context in a const so the animation closure below can use it
	// without non-null assertions (TS widens `ctx` back to nullable inside the closure).
	const c = ctx;
	c.scale(dpr, dpr);

	const particles: Particle[] = [];
	for (let i = 0; i < count; i++) {
		particles.push({
			x: width / 2 + (Math.random() - 0.5) * width * 0.35,
			y: height * 0.42 + (Math.random() - 0.5) * 40,
			vx: (Math.random() - 0.5) * 11,
			vy: Math.random() * -15 - 4,
			rot: Math.random() * Math.PI * 2,
			vr: (Math.random() - 0.5) * 0.4,
			size: Math.random() * 6 + 4,
			color: colors[i % colors.length],
		});
	}

	const gravity = 0.35;
	const drag = 0.99;
	const start = performance.now();

	function frame(now: number): void {
		const elapsed = now - start;
		c.clearRect(0, 0, width, height);
		for (const p of particles) {
			p.vy += gravity;
			p.vx *= drag;
			p.vy *= drag;
			p.x += p.vx;
			p.y += p.vy;
			p.rot += p.vr;
			c.save();
			c.translate(p.x, p.y);
			c.rotate(p.rot);
			c.globalAlpha = Math.max(0, 1 - elapsed / duration);
			c.fillStyle = p.color;
			c.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
			c.restore();
		}
		if (elapsed < duration) {
			requestAnimationFrame(frame);
		} else {
			canvas.remove();
		}
	}

	requestAnimationFrame(frame);
}
