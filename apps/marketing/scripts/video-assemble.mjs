/** Assemble an ordered edit without shell interpolation. Each source is verified before FFmpeg. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
const [manifestPath, outPath] = process.argv.slice(2);
if (!manifestPath || !outPath)
  throw Error("Usage: video-assemble.mjs EDIT.json OUTDIR");
const edit = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(edit.shots) || !edit.shots.length || edit.shots.length > 30)
  throw Error("Provide 1–30 ordered shots");
const out = resolve(outPath);
await mkdir(out, { mode: 0o700 });
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const run = (args) => {
  const result = spawnSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
    { encoding: "utf8" },
  );
  if (result.error || result.status)
    throw Error(result.error?.message ?? result.stderr);
};
for (const [index, shot] of edit.shots.entries()) {
  const bytes = await readFile(shot.file);
  if (createHash("sha256").update(bytes).digest("hex") !== shot.sha256)
    throw Error("Source hash mismatch");
  if (
    !Number.isFinite(shot.duration) ||
    shot.duration < 0.1 ||
    shot.duration > 30
  )
    throw Error("Invalid duration");
  run([
    ...(shot.image ? ["-loop", "1"] : []),
    "-i",
    resolve(shot.file),
    "-t",
    String(shot.duration),
    "-vf",
    "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    join(out, `${index}.mp4`),
  ]);
}
await writeFile(
  join(out, "clips.txt"),
  edit.shots.map((_, i) => `file '${i}.mp4'`).join("\n"),
);
run([
  "-f",
  "concat",
  "-safe",
  "1",
  "-i",
  join(out, "clips.txt"),
  "-c",
  "copy",
  "-movflags",
  "+faststart",
  join(out, "final.mp4"),
]);
run(["-i", join(out, "final.mp4"), "-f", "null", "-"]);
const bytes = await readFile(join(out, "final.mp4"));
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      ...edit,
      output: {
        file: "final.mp4",
        contentType: "video/mp4",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
    null,
    2,
  ),
);
console.log(join(out, "final.mp4"));
