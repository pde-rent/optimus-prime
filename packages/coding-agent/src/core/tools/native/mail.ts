import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../extensions/types.js";
import { NetAuthError, NetError } from "../../net/core.js";
import { sendMail } from "../../net/smtp.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";

/**
 * One mail tool, one transport today (docs/net-stack-spec.md §9.3).
 * IMAP and JMAP plug into the same discriminated union later; the transport
 * literal is already the seam.
 */
const smtpBranch = Type.Object(
	{
		transport: Type.Literal("smtp"),
		op: Type.Union([Type.Literal("send")], {
			description: "send = submit an RFC 5322 message via a submission server (587 STARTTLS / 465 implicit TLS).",
		}),
		host: Type.String({ description: "SMTP server hostname." }),
		port: Type.Optional(Type.Number({ description: "Default 587 (STARTTLS); 465 switches to implicit TLS." })),
		secure: Type.Optional(
			Type.Union([Type.Literal("implicit"), Type.Literal("starttls"), Type.Literal("plain")], {
				description:
					'TLS mode. Default: implicit for 465, starttls otherwise; "plain" opts out for local relays only.',
			}),
		),
		user: Type.Optional(
			Type.String({
				description:
					"SMTP username as an environment-variable NAME or literal - prefer passing just the env var name, never a literal password.",
			}),
		),
		secret: Type.Optional(
			Type.String({
				description:
					"Password as an environment-variable NAME (recommended), a literal, or a !-prefixed shell command that prints it.",
			}),
		),
		secretCommand: Type.Optional(
			Type.String({
				description: 'Shell command printing the password, e.g. "!security find-generic-password -s smtp".',
			}),
		),
		from: Type.String({ description: 'Sender address, e.g. "Name <user@host>".' }),
		to: Type.Array(Type.String(), {
			minItems: 1,
			description: "Primary recipient addresses (display names allowed).",
		}),
		cc: Type.Optional(Type.Array(Type.String(), { description: "Carbon-copy recipients." })),
		bcc: Type.Optional(
			Type.Array(Type.String(), {
				description: "Blind recipients: delivered via the envelope but never written into message headers.",
			}),
		),
		subject: Type.Optional(
			Type.String({ description: "Subject line; non-ASCII is RFC 2047 encoded automatically." }),
		),
		body: Type.Optional(Type.String({ description: "Plain-text body." })),
		attachPaths: Type.Optional(
			Type.Array(Type.String(), { description: "Reserved for v2 multipart support; currently rejected." }),
		),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-read deadline in milliseconds (default 30000)." })),
	},
	{ additionalProperties: false },
);

const mailSchema = Type.Union([smtpBranch], {
	description: "Pick exactly one transport object; additional fields from other transports are rejected.",
});

export type MailToolInput = Static<typeof mailSchema>;

export interface MailToolDetails {
	transport: "smtp";
	op: string;
	recipients: number;
	messageId?: string;
}

/**
 * Send email through an SMTP submission server.
 *
 * Use it when the conversation has already confirmed the recipient(s) and the
 * content is plain text - credentials come from env-var names or a
 * secretCommand, never literals pasted into the call. Do NOT use it to read
 * mail (no IMAP/JMAP yet), to send attachments (reserved), or to send on
 * someone's behalf without their explicit confirmation. bcc recipients are
 * never echoed back. Output: "queued to <n> recipients; server: <enhanced
 * status code>". Failures carry protocol detail verbatim: e.g.
 * "Recipient refused: nobody@invalid - 550 5.1.1 No such user."
 */
export function createMailToolDefinition(cwd: string): ToolDefinition<typeof mailSchema, MailToolDetails> {
	void cwd;
	const definition: ToolDefinition<typeof mailSchema, MailToolDetails> = {
		name: "mail",
		label: "mail",
		description:
			"Send email over SMTP submission (op=send): STARTTLS + AUTH PLAIN|LOGIN, dot-stuffed DATA - the default and fastest way to send mail from here; runs in-process on Windows/macOS/Linux; replaces hand-rolled bash SMTP or curl. Pass credential ENV-VAR NAMES (or secretCommand), never literal passwords. Not for reading mail.",
		promptSnippet: "Send email via SMTP submission - STARTTLS + AUTH, dot-stuffed DATA",
		parameters: mailSchema,
		executionMode: "sequential",
		kind: "edit",
		read_only: false,
		async execute(
			_toolCallId,
			input: MailToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: MailToolDetails }> {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (input.transport !== "smtp")
				throw new Error(`Unknown mail transport: ${String((input as { transport?: unknown }).transport)}`);

			try {
				const result = await sendMail({
					host: input.host,
					port: input.port,
					tls: input.secure,
					auth: input.user
						? { user: input.user, secret: input.secret, secretCommand: input.secretCommand }
						: undefined,
					message: {
						from: input.from,
						to: input.to,
						cc: input.cc,
						bcc: input.bcc,
						subject: input.subject,
						body: input.body,
						attachPaths: input.attachPaths,
					},
					timeoutMs: input.timeoutMs ?? 30_000,
					signal,
				});
				return {
					content: [
						{
							type: "text",
							text: `queued to ${result.acceptedRecipients} recipients; server: ${result.serverReply}`,
						},
					],
					details: {
						transport: "smtp",
						op: "send",
						recipients: result.acceptedRecipients,
						messageId: result.messageId,
					},
				};
			} catch (error: unknown) {
				if (error instanceof NetAuthError) {
					throw new Error(`Authentication failed for ${input.user}. ${error.message}`);
				}
				if (error instanceof NetError && error.code === "NET_CONNECT") {
					throw new Error(`Could not connect to ${input.host}:${input.port ?? 587}. ${error.message}`);
				}
				throw error;
			}
		},
	};
	return definition;
}

export function createMailTool(cwd: string) {
	return wrapToolDefinition(createMailToolDefinition(cwd));
}
