function jpegSegment(marker: number, data: Buffer): Buffer {
	const head = Buffer.from([0xff, marker, 0, 0]);
	head.writeUInt16BE(data.length + 2, 2);
	return Buffer.concat([head, data]);
}

/** A tiny JPEG whose APP1 EXIF, APP13, comment, and trailing bytes all carry `GPS`; only the pixels survive a strip. */
export function jpegWithGpsExif(): Buffer {
	return Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x01", "latin1")),
		jpegSegment(0xe1, Buffer.from("Exif\0\0MMGPSLatitude 51.5074 N", "latin1")),
		jpegSegment(0xed, Buffer.from("Photoshop 3.0 GPS", "latin1")),
		jpegSegment(0xfe, Buffer.from("comment GPS", "latin1")),
		jpegSegment(0xdb, Buffer.alloc(65, 3)),
		jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
		Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
		Buffer.from([0xff, 0xd9]),
		Buffer.from("trailing GPS", "latin1"),
	]);
}
