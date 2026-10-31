/// <reference path="../qrcode.d.ts" />
import QRCode from "qrcode";

export async function renderQr(uri: string): Promise<string> {
	const image = await QRCode.toString(uri, { type: "utf8", errorCorrectionLevel: "L" });
	if (!image.includes("\n")) throw new Error("QR renderer returned no image");
	return image;
}
