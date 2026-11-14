/** Local media executor for an agent using Planning's MCP documents. Secrets stay here. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
async function api(url, options = {}) {
  if (new URL(url).origin !== "https://queue.fal.run")
    throw Error("Queue origin refused");
  const result = await fetch(url, {
    ...options,
    redirect: "error",
    headers: {
      Authorization: `Key ${process.env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!result.ok) throw Error(`fal HTTP ${result.status}`);
  return result.json();
}
export async function main([command, file, directory, image]) {
  if (!["submit", "collect"].includes(command) || !file || !directory)
    throw Error(
      "Usage: video-executor.mjs submit CLAIM.json OUTDIR [SOURCE_IMAGE] | collect CLAIM.json OUTDIR",
    );
  if (!process.env.FAL_KEY)
    throw Error("FAL_KEY is required in the environment");
  const take = JSON.parse(await readFile(file, "utf8"));
  const out = resolve(directory);
  if (command === "submit") {
    if (take.state !== "submitting" || take.claimed !== true)
      throw Error(
        "A fresh successful UpdateVideoTake submitting claim is required",
      );
    const { model, sourceAssetId, ...input } = take.request;
    if (
      ![
        "alibaba/wan-3.0/text-to-video",
        "alibaba/wan-3.0/image-to-video",
      ].includes(model)
    )
      throw Error("Unsupported model");
    if (sourceAssetId) {
      if (!image)
        throw Error("Download the pinned source asset before submission");
      const bytes = await readFile(image);
      if (sha(bytes) !== take.shot.source.artifact.contentHash)
        throw Error("Source image hash differs from pinned evidence");
      input.start_image_url = `data:${bytes[0] === 137 ? "image/png" : "image/jpeg"};base64,${bytes.toString("base64")}`;
    }
    // Atomic one-shot directory prevents resubmission even when the POST response was lost.
    await mkdir(out, { mode: 0o700 });
    await save(`${out}/request.json`, {
      takeId: take.id,
      model,
      input,
      startedAt: new Date().toISOString(),
    });
    try {
      const receipt = await api(`https://queue.fal.run/${model}`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      await save(`${out}/receipt.json`, receipt);
      await save(`${out}/next-mutation.json`, {
        document: "UpdateVideoTake",
        input: {
          id: take.id,
          revision: take.revision,
          state: "submitted",
          providerRequestId: receipt.request_id,
        },
      });
    } catch (error) {
      await save(`${out}/next-mutation.json`, {
        document: "UpdateVideoTake",
        input: {
          id: take.id,
          revision: take.revision,
          state: "uncertain",
          error: String(error.message),
        },
      });
      throw error;
    }
  } else {
    const receipt = JSON.parse(await readFile(`${out}/receipt.json`, "utf8"));
    const status = await api(receipt.status_url);
    await save(`${out}/status.json`, status);
    if (status.status !== "COMPLETED") {
      console.log(status.status);
      return;
    }
    const result = await api(receipt.response_url);
    await save(`${out}/result.json`, result);
    const url = new URL(result.video.url);
    if (
      url.protocol !== "https:" ||
      !(url.hostname.endsWith(".fal.media") || url.hostname === "fal.media")
    )
      throw Error("Unexpected media origin");
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw Error(`Media HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 25 * 1024 * 1024)
      throw Error("Output exceeds storage limit; retain and transcode locally");
    await writeFile(`${out}/raw.mp4`, bytes, { mode: 0o600 });
    await save(`${out}/artifact.json`, {
      contentType: "video/mp4",
      size: bytes.length,
      sha256: sha(bytes),
      providerRequestId: receipt.request_id,
    });
  }
  console.log(
    `Saved ${out}; continue with the recorded Planning mutation and upload documents.`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
