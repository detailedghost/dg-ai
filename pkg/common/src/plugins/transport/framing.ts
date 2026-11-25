import { decodeFrame, FRAME_HEADER_BYTES, FRAME_MAX_PAYLOAD_BYTES, type DecodedFrame } from "../contract";

export { decodeFrame, encodeFrame } from "../contract";

export class FrameReader {
	private buffer: Uint8Array = new Uint8Array(0);

	push(chunk: Uint8Array): DecodedFrame[] {
		this.buffer = this.buffer.length === 0 ? chunk : concat(this.buffer, chunk);
		const frames: DecodedFrame[] = [];
		while (this.buffer.length >= FRAME_HEADER_BYTES) {
			const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
			const length = view.getUint32(8, false);
			if (length > FRAME_MAX_PAYLOAD_BYTES) decodeFrame(this.buffer.subarray(0, FRAME_HEADER_BYTES));
			const end = FRAME_HEADER_BYTES + length;
			if (this.buffer.length < end) break;
			frames.push(decodeFrame(this.buffer.slice(0, end)));
			this.buffer = this.buffer.subarray(end);
		}
		return frames;
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}
