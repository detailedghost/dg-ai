import MailComposer from "nodemailer/lib/mail-composer";
import PostalMime from "postal-mime";
import type { Address, Attachment, Email, Mailbox } from "postal-mime";
import { htmlToText } from "../mail/html-text";
import type { MailAttachment } from "../mail/types";

export type ParsedMimeMessage = {
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	receivedAt: string;
	messageId?: string;
	references?: string;
	text: string;
	html?: string;
	attachments: MailAttachment[];
};

export type ComposeMimeInput = {
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	text: string;
	inReplyTo?: string;
	references?: string;
};

function formatMailbox(address: Mailbox | undefined): string {
	if (!address) return "";
	return address.name ? `${address.name} <${address.address}>` : address.address;
}

function flattenAddress(address: Address): string[] {
	return address.group ? address.group.map(formatMailbox) : [formatMailbox(address)];
}

function formatAddress(address: Address | undefined): string {
	if (!address) return "";
	return address.group ? address.group.map(formatMailbox).join(", ") : formatMailbox(address);
}

function attachmentSize(content: Attachment["content"]): number {
	if (typeof content === "string") return Buffer.byteLength(content);
	return content.byteLength;
}

function toMailAttachment(attachment: Attachment, index: number): MailAttachment {
	return {
		id: attachment.contentId ?? `part-${index}`,
		name: attachment.filename ?? "attachment",
		contentType: attachment.mimeType,
		size: attachmentSize(attachment.content),
		isInline: attachment.disposition === "inline",
	};
}

function bodyTextFrom(email: Pick<Email, "text" | "html">): string {
	if (email.text && email.text.length > 0) return email.text;
	if (email.html) return htmlToText(email.html);
	return "";
}

/** Parses a full RFC822 source into the fields `getMessage` needs; never touches the network. */
export async function parseMimeMessage(source: Buffer | string): Promise<ParsedMimeMessage> {
	const email = await PostalMime.parse(source);
	const text = bodyTextFrom(email);
	return {
		from: formatAddress(email.from),
		to: (email.to ?? []).flatMap(flattenAddress),
		cc: (email.cc ?? []).flatMap(flattenAddress),
		subject: email.subject ?? "",
		receivedAt: new Date(email.date ?? Date.now()).toISOString(),
		messageId: email.messageId,
		references: email.references,
		text,
		html: email.html,
		attachments: email.attachments.map(toMailAttachment),
	};
}

/** Builds a draft or reply as RFC822 bytes ready for IMAP APPEND; Message-ID is left to nodemailer. */
export async function composeMimeMessage(input: ComposeMimeInput): Promise<Buffer> {
	const composer = new MailComposer({
		from: input.from,
		to: input.to.join(", "),
		cc: input.cc.length > 0 ? input.cc.join(", ") : undefined,
		subject: input.subject,
		text: input.text,
		inReplyTo: input.inReplyTo,
		references: input.references,
		date: new Date(),
	});
	return await new Promise<Buffer>((resolve, reject) => {
		composer.compile().build((error: Error | null, message: Buffer) => {
			if (error) reject(error);
			else resolve(message);
		});
	});
}
