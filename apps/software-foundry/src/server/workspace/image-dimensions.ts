/** Dimensions of the bounded original PNG, never its browser/tool rendering.
 * `maxBytes` defaults to the 512 KiB run-screenshot cap. */
export function imageDimensions(bytes: Uint8Array, { maxBytes = 512 * 1024 } = {}) {
  if (bytes.length < 33 || bytes.length > maxBytes ||
    bytes.subarray(0, 8).some((byte, index) => byte !== [137,80,78,71,13,10,26,10][index]) ||
    new TextDecoder().decode(bytes.subarray(12,16)) !== "IHDR")
    throw new Response("A bounded PNG screenshot is required", { status: 422 });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (view.getUint32(8) !== 13 || !width || !height || width > 10000 || height > 10000 || width * height > 50_000_000)
    throw new Response("Invalid screenshot dimensions", { status: 422 });
  return { width, height };
}
