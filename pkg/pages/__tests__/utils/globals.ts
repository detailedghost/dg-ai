export function captureGlobal(name: string): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	return () => {
		if (original) {
			Object.defineProperty(globalThis, name, original);
		} else {
			Reflect.deleteProperty(globalThis, name);
		}
	};
}
