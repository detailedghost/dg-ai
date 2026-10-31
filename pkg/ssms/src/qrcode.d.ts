declare module "qrcode" {
	const QRCode: {
		toString(
			text: string,
			options: { type: "utf8"; errorCorrectionLevel?: "L" | "M" | "Q" | "H" },
		): Promise<string>;
	};
	export default QRCode;
}
