import assert from "node:assert/strict";
import test from "node:test";
import { guestChatPath, guestChatTransport, guestOutcome, guestTurnBody, guestTurnText } from "../src/guest-chat";

test("the guest transport sends only the newest text (and an example) to the platform's guest endpoint", async () => {
  const seen: { url: string; outcome: string }[] = [];
  const contexts: unknown[] = [];
  const transport = guestChatTransport({
    fixture: "landing-1",
    fetch: (async (url: string) => new Response("stream", { status: 429, headers: { "X-Outfitter-Chat-Context": JSON.stringify({ model: "m", phase: "Last request", extra: 1 }) } })) as typeof fetch,
    onResponse: (response, outcome) => seen.push({ url: response.url, outcome }),
    onContext: (context) => contexts.push(context),
  });
  assert.equal(transport.api, guestChatPath);
  const body = transport.prepareSendMessagesRequest({ messages: [
    { role: "user", parts: [{ type: "text", text: "old" }] },
    { role: "assistant", parts: [{ type: "text", text: "reply" }] },
    { role: "user", parts: [{ type: "text", text: "new" }, { type: "file" }, { type: "text", text: "line" }] },
  ] }).body;
  assert.deepEqual(body, { text: "new\n\nline", fixture: "landing-1" });
  assert.equal(guestTurnBody.safeParse(body).success, true);
  await transport.fetch(guestChatPath, { method: "POST" });
  assert.deepEqual(seen.map((s) => s.outcome), ["limit"]);
  assert.deepEqual(contexts, [{ model: "m", phase: "Last request", extra: 1 }]);
});

test("guest outcomes and bodies mirror the platform's admission answers", () => {
  assert.deepEqual([200, 409, 429, 503, 400, 403, 500].map(guestOutcome), ["ok", "signed-in", "limit", "unavailable", "refused", "refused", "retry"]);
  assert.equal(guestTurnText([]), "");
  assert.equal(guestTurnBody.safeParse({ text: "x".repeat(2001) }).success, false);
  assert.equal(guestTurnBody.safeParse({ text: "hi", token: "forged" }).success, false, "the browser never supplies session or policy fields");
});
