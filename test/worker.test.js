import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import worker from "../worker.js";

test("Cloudflare entry serves the health endpoint", async () => {
  const reply = await worker.fetch(new Request("https://worker.example/health"), {});
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { ok: true });
});

test("Cloudflare entry returns 404 for unknown routes", async () => {
  const reply = await worker.fetch(new Request("https://worker.example/unknown"), {});
  assert.equal(reply.status, 404);
});

function probeRequest() {
  return new Request("https://relay.example/feedback/supplement", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: 1,
      number: 999999,
      replyKey: Buffer.alloc(32).toString("base64url"),
      requestId: randomUUID(),
      description: "fixture relay probe",
      diagnostics: null,
      appVersion: "1.3.11",
    }),
  });
}

test("a reused Worker switches to the rotated GitHub binding", async (t) => {
  const oldBinding = "old-binding-fixture";
  const newBinding = "rotated-binding-fixture";
  const requests = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).pathname, "/repos/wushuai0802/myfinder-device-battery/issues/999999");
    assert.equal(options.method, "GET");
    const authorization = new Headers(options.headers).get("Authorization");
    requests.push(authorization);
    return Response.json({}, { status: authorization === `Bearer ${newBinding}` ? 404 : 401 });
  });

  const before = await worker.fetch(probeRequest(), { FEEDBACK_GITHUB_TOKEN: oldBinding });
  assert.equal(before.status, 502);
  const after = await worker.fetch(probeRequest(), { FEEDBACK_GITHUB_TOKEN: newBinding });
  assert.equal(after.status, 403);
  assert.deepEqual(await after.json(), { error: "denied" });
  assert.deepEqual(requests, [`Bearer ${oldBinding}`, `Bearer ${newBinding}`]);
});
