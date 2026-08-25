import type { MailIntakeConfig } from "./config";

/** Minimal REST client for the AgentMail endpoints this service uses. */

export interface AgentMailAttachmentMeta {
  attachment_id: string;
  filename?: string;
  content_type?: string;
  size?: number;
  inline?: boolean;
}

export interface AgentMailMessage {
  inbox_id: string;
  thread_id: string;
  message_id: string;
  from?: string;
  from_?: string;
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: AgentMailAttachmentMeta[];
  timestamp?: string;
}

export class AgentMailError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AgentMailError";
  }
}

async function request(
  config: MailIntakeConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${config.AGENTMAIL_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.AGENTMAIL_API_KEY}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AgentMailError(
      `AgentMail ${init.method ?? "GET"} ${path} failed: ${response.status} ${body.slice(0, 300)}`,
      response.status,
    );
  }
  return response;
}

export async function getMessage(
  config: MailIntakeConfig,
  messageId: string,
): Promise<AgentMailMessage> {
  const response = await request(
    config,
    `/inboxes/${encodeURIComponent(config.AGENTMAIL_INBOX_ID)}/messages/${encodeURIComponent(messageId)}`,
  );
  return (await response.json()) as AgentMailMessage;
}

export async function getAttachment(
  config: MailIntakeConfig,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const response = await request(
    config,
    `/inboxes/${encodeURIComponent(config.AGENTMAIL_INBOX_ID)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  const raw = Buffer.from(await response.arrayBuffer());
  // The endpoint returns JSON metadata with a presigned download_url; the file
  // bytes live on the CDN. Fall back to treating the body as the file itself
  // if the response is not that JSON shape.
  try {
    const meta = JSON.parse(raw.toString("utf8")) as { download_url?: string };
    if (meta.download_url) {
      const file = await fetch(meta.download_url, { signal: AbortSignal.timeout(60_000) });
      if (!file.ok) {
        throw new AgentMailError(`Attachment CDN download failed: ${file.status}`, file.status);
      }
      return Buffer.from(await file.arrayBuffer());
    }
  } catch (err) {
    if (err instanceof AgentMailError) throw err;
    // Not JSON — the body already is the attachment.
  }
  return raw;
}

export async function replyToMessage(
  config: MailIntakeConfig,
  messageId: string,
  body: { text: string; html?: string },
): Promise<void> {
  await request(
    config,
    `/inboxes/${encodeURIComponent(config.AGENTMAIL_INBOX_ID)}/messages/${encodeURIComponent(messageId)}/reply`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function sendMessage(
  config: MailIntakeConfig,
  to: string,
  subject: string,
  body: { text: string; html?: string },
): Promise<void> {
  await request(
    config,
    `/inboxes/${encodeURIComponent(config.AGENTMAIL_INBOX_ID)}/messages/send`,
    { method: "POST", body: JSON.stringify({ to: [to], subject, ...body }) },
  );
}

/** Extract the bare email address from a From header like `Name <a@b.com>`. */
export function bareAddress(from: string | undefined): string {
  if (!from) return "";
  const match = /<([^>]+)>/.exec(from);
  return (match ? match[1]! : from).trim().toLowerCase();
}
