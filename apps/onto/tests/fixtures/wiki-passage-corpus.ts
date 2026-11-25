import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker, type Member } from "@ai-outfitter/app-test/worker";
import { parseDirectUpload } from "@ai-outfitter/app-sdk/storage";

export const actionsPath = "/api/internal/actions/v1/call";
export const sourceSlug = "synthetic-copper-observatory";
export const sourceTitle = "Synthetic Copper Observatory";
export const phrases = {
  wiki: "cyclamen pendulum baseline",
  revised: "amaranth gyroscope revision",
  pdfDecoy: "parchment weathervane placeholder",
  pdf: "vermilion spectrometer calibration",
  transcriptDecoy: "porcelain telescope warmup",
  transcript: "ultramarine seismometer alignment",
  foreign: "obsidian sextant isolation",
};

export const sourceText = {
  wiki: `${phrases.wiki}: Copper Sensor records the baseline beside Obsidian Sextant.`,
  pdf: `Copper Sensor connects to Amber Recorder and Cinnabar Relay during ${phrases.pdf}.`,
  transcript: `${phrases.transcript} was logged by Shared Receiver.`,
  foreign: `${phrases.foreign}: Obsidian Sextant is owned by Beta.`,
};

export async function json<T>(response: Response): Promise<T> {
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  return JSON.parse(raw) as T;
}

/** Write an ordinary two-page text PDF, including byte offsets for its xref. */
function sourcePdf() {
  const content = (value: string) => {
    const stream = `BT /F1 10 Tf 40 740 Td (${value}) Tj ET\n`;
    return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
  };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    content(phrases.pdfDecoy),
    content(sourceText.pdf),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const transcript = Buffer.from([
  "WEBVTT",
  "",
  "00:00:04.000 --> 00:00:08.000",
  phrases.transcriptDecoy,
  "",
  "00:02:13.500 --> 00:02:19.750",
  sourceText.transcript,
  "",
].join("\n"));

type DocumentRevision = { id: string; revision: number; publishedRevision: number | null };
type Attachment = {
  status: "attached";
  sha256: string;
  downloadUrl: string;
};
const wikiPackage = appArtifact(new URL("../../../wiki", import.meta.url), "operational");

export async function createWikiCorpus(owner: Member, installationId: string) {
  const worker = await appWorker("wiki-map", wikiPackage, installationId);
  const path = "/api/apps/wiki-map/documents";
  const reader = { ...owner, userId: `${owner.organizationId}-reader`, role: "member" };
  const operate = <T>(operation: string, input: object) => worker.call(path, owner, {
    method: "POST", body: { operation, variables: { input } },
  }).then(json<T>);
  const save = async (body: string, prior?: DocumentRevision, slug = sourceSlug) => {
    const input = prior ? { id: prior.id, revision: prior.revision } : { slug };
    const result = await operate<{ saveDocument: DocumentRevision }>("SaveDocument", { ...input, title: sourceTitle, body });
    return result.saveDocument;
  };
  const publish = async ({ id, revision }: DocumentRevision) => {
    const result = await operate<{ publishDocument: DocumentRevision }>("PublishDocument", { id, revision });
    assert.equal(result.publishDocument.publishedRevision, revision);
    return result.publishDocument;
  };
  const archive = async ({ id, revision }: DocumentRevision) => {
    const result = await operate<{ archiveDocument: { archived: boolean } }>("ArchiveDocument", { id, revision });
    assert.equal(result.archiveDocument.archived, true);
  };
  async function upload(fileName: string, contentType: string, bytes: Buffer): Promise<Attachment> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const input = { pageSlug: sourceSlug, fileName, contentType, size: bytes.length, sha256 };
    const query = `mutation Upload($input: UploadWikiPageFileInput!) {
      uploadWikiPageFile(input: $input)
    }`;
    const submit = async () => {
      const result = await json<{ data: { uploadWikiPageFile: Attachment | { status: "awaiting_upload"; upload: { url: string } } }; errors?: unknown }>(
        await worker.call(actionsPath, owner, {
          method: "POST", body: { action: "graph.mutate", input: { query, variables: { input } } },
        }),
      );
      assert.equal(result.errors, undefined);
      return result.data.uploadWikiPageFile;
    };
    const pending = await submit();
    assert.equal(pending.status, "awaiting_upload");
    const target = parseDirectUpload(pending.upload.url);
    assert.ok(target);
    // App-test does not serve the platform's signed PUT endpoint. Only the
    // transfer of bytes at the ticket's key is fixture I/O.
    await (await worker.bucket(target.bucket)).put(target.key, bytes);
    const receipt = await submit();
    assert.equal(receipt.status, "attached");
    assert.equal(receipt.sha256, sha256);
    const download = await worker.call(`/${receipt.downloadUrl}`, reader);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    return receipt;
  }
  return {
    wiki: worker, reader, save, publish, archive, upload,
    attachPdf: () => upload("calibration.pdf", "application/pdf", sourcePdf()),
    attachTranscript: () => upload("interview.vtt", "text/vtt", transcript),
  };
}
