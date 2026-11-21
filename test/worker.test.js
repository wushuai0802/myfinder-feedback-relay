import { test } from "node:test";
import assert from "node:assert/strict";
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
