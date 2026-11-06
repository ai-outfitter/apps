export async function readBytes(
  request: Pick<Request, "body">,
  limit = 65536,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new Response("Missing body", { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      // A cloned request tees its body: awaiting cancel can wait forever for
      // the untouched branch. Reject immediately while cancellation completes.
      void reader.cancel().catch(() => {});
      throw new Response("Request too large", { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}


export async function readText(request: Pick<Request, "body">, limit = 65536): Promise<string> {
  return new TextDecoder().decode(await readBytes(request, limit));
}
