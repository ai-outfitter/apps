/** Shared input capabilities; transports enforce these limits again on the server. */
export const effortLevels = ["low", "high", "max"] as const;
export type Effort = (typeof effortLevels)[number];
export const defaultEffort: Effort = "high";
export const attachmentTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const imageAttachments = {
  accept: attachmentTypes.join(","),
  maxFiles: 4,
  maxBytes: MAX_ATTACHMENT_BYTES,
};
export type ChatAttachment = {
  id: string;
  filename: string;
  mediaType: (typeof attachmentTypes)[number];
};
export const appAttachmentPath = (id: string) =>
  `/api/platform/agent/attachments/${id}`;
