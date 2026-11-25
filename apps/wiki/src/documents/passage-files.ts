import { getDocumentProxy } from "unpdf";

export type Locator =
  | { kind: "wiki-page"; section: "title" | "summary" | "body" | "generatedBody" }
  | { kind: "pdf-page"; page: number }
  | { kind: "transcript"; startMs: number; endMs: number };

export type Section = { text: string; locator: Locator };
export class UnsupportedPassageFile extends Error {}

const timestamp = "(?:(\\d{2,}):)?([0-5]\\d):([0-5]\\d)[.,](\\d{3})";
const cueTiming = new RegExp(`^${timestamp} +--> +${timestamp}(?:[ \\t].*)?$`);
const toMilliseconds = ([hours, minutes, seconds, millis]: string[]) =>
  (((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(millis));

function cues(text: string): Section[] {
  const result: Section[] = [];
  for (const block of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split(/\n[ \t]*\n/)) {
    const lines = block.trim().split("\n");
    if (/^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
    const index = lines[0].includes("-->") ? 0 : 1;
    const timing = cueTiming.exec(lines[index] ?? "");
    if (!timing) continue;
    const startMs = toMilliseconds(timing.slice(1, 5));
    const endMs = toMilliseconds(timing.slice(5, 9));
    if (!Number.isSafeInteger(endMs) || endMs <= startMs) continue;
    const excerpt = lines.slice(index + 1).join("\n");
    if (excerpt.trim()) result.push({ text: excerpt, locator: { kind: "transcript", startMs, endMs } });
  }
  return result;
}

export function passageFormat(contentType: string, fileName: string) {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (type === "application/pdf" || /\.pdf$/i.test(fileName)) return "pdf";
  if (["text/vtt", "application/x-subrip", "text/srt"].includes(type) || /\.(vtt|srt)$/i.test(fileName)) return "transcript";
  return null;
}

export async function extractPassageFile(bytes: ArrayBuffer, format: "pdf" | "transcript"): Promise<Section[]> {
  if (format === "transcript") return cues(new TextDecoder().decode(bytes));
  try {
    const pdf = await getDocumentProxy(bytes, {
      // Index only embedded text. PDF resources and scripts never load over the network.
      useWorkerFetch: false, isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
    });
    try {
      if (pdf.numPages > 600) throw new UnsupportedPassageFile("PDF exceeds the 600-page indexing limit");
      const pages: Section[] = [];
      let characters = 0;
      for (let page = 1; page <= pdf.numPages; page++) {
        const reader = await pdf.getPage(page);
        try {
          const { items } = await reader.getTextContent();
          const text = items.flatMap(item => "str" in item ? [item.str, item.hasEOL ? "\n" : " "] : []).join("");
          pages.push({ text, locator: { kind: "pdf-page", page } });
          characters += text.length;
          if (characters > 500_000)
            throw new UnsupportedPassageFile("PDF exceeds the extracted-text indexing limit");
        } finally {
          reader.cleanup();
        }
      }
      return pages;
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch (error) {
    if (error instanceof UnsupportedPassageFile) throw error;
    if (error instanceof Error && ["InvalidPDFException", "PasswordException", "MissingPDFException"].includes(error.name))
      throw new UnsupportedPassageFile("PDF is invalid or requires a password");
    throw new Response("PDF text extractor unavailable", { status: 503 });
  }
}
