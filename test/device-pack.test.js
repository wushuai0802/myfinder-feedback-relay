import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { createHandler } from "../handler.js";

const BASE = "https://relay.invalid/device-pack/v1/";
const UPSTREAM = "https://github.com/wushuai0802/myfinder-device-battery/releases/download/device-pack/";
const VERSION = "device-pack-v1-1.json";
const LATEST = "device-pack-v1-latest.json";
const SIGNATURE = VERSION + ".sig";
const ADDRESS = "192.0.2.42";
const TOKEN = "test-only-server-secret";
const NOW = Date.parse("2026-11-04T08:30:00.000Z");

before(() => mock.method(globalThis, "fetch", () => {
  throw new Error("Unexpected global fetch; inject a fake fetch in tests");
}));
after(() => mock.restoreAll());

function upstream(body = '{"schema":1}', { url = UPSTREAM + VERSION, ...init } = {}) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function request(filename = VERSION, options) {
  return new Request(BASE + filename, options);
}

function setup({ fetch = () => upstream(), ...options } = {}) {
  const calls = [];
  const logs = [];
  const handler = createHandler({
    token: TOKEN,
    now: () => NOW,
    log: (...args) => logs.push(args),
    ...options,
    fetch: (url, init) => {
      calls.push({ url, ...init });
      return fetch(url, init);
    },
  });
  return { handler, calls, logs };
}

function noCors(response) {
  for (const [name] of response.headers) assert.ok(!name.startsWith("access-control-"));
}

async function expectError(response, status, { head = false, nosniff = true } = {}) {
  assert.equal(response.status, status);
  noCors(response);
  if (nosniff) assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), null);
  assert.equal(response.headers.get("etag"), null);
  if (head) assert.equal(await response.text(), "");
  else assert.deepEqual(await response.json(), {
    error: status === 429 ? "rate_limited" : status === 502 ? "unavailable" : "invalid",
  });
}

test("legal filenames have fixed upstream URLs, exact bytes and mirror headers", async (t) => {
  for (const filename of [LATEST, VERSION, SIGNATURE, "device-pack-v1-9.json",
    "device-pack-v1-10.json.sig", "device-pack-v1-9999999999.json", "device-pack-v1-9999999999.json.sig"]) {
    await t.test(filename, async () => {
      const bytes = new TextEncoder().encode(' {"名称":"鼠标"}\n');
      const { handler, calls, logs } = setup({ fetch: () => upstream(bytes, { headers: {
        ETag: '"pack-1"', "Content-Type": "text/html", "Cache-Control": "private",
        "Access-Control-Allow-Origin": "*", "Set-Cookie": "private=1",
      } }) });
      const response = await handler(request(filename), ADDRESS);
      assert.equal(response.status, 200);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      assert.equal(response.headers.get("content-type"), filename.endsWith(".sig") ? "text/plain" : "application/json");
      assert.equal(response.headers.get("cache-control"), filename === LATEST
        ? "public, max-age=300" : "public, max-age=86400, immutable");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("etag"), '"pack-1"');
      assert.equal(response.headers.get("set-cookie"), null);
      noCors(response);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, UPSTREAM + filename);
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].redirect, "follow");
      assert.ok(calls[0].signal instanceof AbortSignal);
      assert.equal(calls[0].signal.aborted, false);
      assert.deepEqual(logs, []);
    });
  }
});

test("invalid names, traversal, encodings and case variants are 404 without fetch", async () => {
  const { handler, calls, logs } = setup();
  const names = [
    "", ".", "..", "../" + VERSION, "../../missing", "dir/" + VERSION,
    VERSION + "/", VERSION + "/extra", "device-pack-v1-0.json", "device-pack-v1-01.json",
    "device-pack-v1--1.json", "device-pack-v1-+1.json", "device-pack-v1-1.0.json",
    "device-pack-v1-10000000000.json", "device-pack-v1-١.json", "device-pack-v1-１.json",
    "device-pack-v1-LATEST.json", "Device-pack-v1-1.json", "device-pack-v1-1.JSON",
    "device-pack-v1-1.json.SIG", LATEST + ".sig", VERSION + ".sig.sig",
    "device-pack-v2-1.json", "device-pack-v1-.json", VERSION + ".exe",
    "prefix-" + VERSION, VERSION + "%00", VERSION + "%0a", VERSION + "%20",
    "%64evice-pack-v1-1.json", "device-pack-v1-%31.json", "device-pack-v1-1%2ejson",
    "device-pack-v1-%256c%2561test.json", "%2e%2e/" + VERSION,
    "%252e%252e%252f" + VERSION, VERSION + "%2fextra", VERSION + "%5cextra",
    "https:%2f%2fevil.invalid%2f" + VERSION, VERSION + ";url=https://evil.invalid",
  ];
  for (const filename of names) {
    await expectError(await handler(request(filename), ADDRESS), 404, { nosniff: false });
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, []);
});

test("only GET and HEAD are accepted; invalid names remain 404 for other methods", async () => {
  const { handler, calls } = setup();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await handler(request(VERSION, { method }), ADDRESS);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    await expectError(response, 405);
    await expectError(await handler(request(LATEST + ".sig", { method }), ADDRESS), 404);
  }
  assert.equal(calls.length, 0);
});

test("mirror ignores incoming queries and headers and never uses feedback credentials or repo", async () => {
  const { handler, calls } = setup({
    repo: "other/private-repo", disabled: true,
    fetch: () => upstream("{}", { headers: { ETag: '"current"' } }),
  });
  const response = await handler(request(VERSION + "?url=https://evil.invalid/&token=client-secret", { headers: {
    Authorization: "Bearer client-secret", Cookie: "session=client-secret", Range: "bytes=0-1",
    "If-None-Match": '"current"', "X-Forwarded-For": "198.51.100.1", "X-Private": "client-secret",
  } }), ADDRESS);
  assert.equal(response.status, 304);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, UPSTREAM + VERSION);
  assert.deepEqual([...new Headers(calls[0].headers)], []);
  assert.equal(calls[0].credentials, "omit");
  assert.equal(calls[0].body, undefined);
  assert.ok(!JSON.stringify(calls[0]).includes(TOKEN));
  assert.ok(!JSON.stringify(calls[0]).includes("client-secret"));
  assert.equal((await handler(request(VERSION + "?different=1"), ADDRESS)).status, 200);
  assert.equal(calls.length, 1);
  const withoutToken = setup({ token: undefined });
  assert.equal((await withoutToken.handler(request(), ADDRESS)).status, 200);
});

test("HEAD validates and caches the same representation as GET with no response body", async () => {
  for (const filename of [LATEST, VERSION, SIGNATURE]) {
    const { handler, calls } = setup({ fetch: () => upstream("content", { headers: { ETag: '"same"' } }) });
    const head = await handler(request(filename, { method: "HEAD" }), ADDRESS);
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    const get = await handler(request(filename), ADDRESS);
    assert.deepEqual([...head.headers], [...get.headers]);
    assert.equal(await get.text(), "content");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    const unchanged = await handler(request(filename, { method: "HEAD", headers: { "If-None-Match": '"same"' } }), ADDRESS);
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body, null);
  }
  for (const [status, expected] of [[404, 404], [500, 502]]) {
    const { handler } = setup({ fetch: () => upstream("private upstream body", { status }) });
    await expectError(await handler(request(VERSION, { method: "HEAD" }), ADDRESS), expected, { head: true });
  }
  const { handler } = setup();
  await expectError(await handler(request(LATEST + ".sig", { method: "HEAD" }), ADDRESS), 404, { head: true });
});

test("final response URL must have an exact allowed HTTPS host", async (t) => {
  for (const host of ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]) {
    const { handler } = setup({ fetch: () => upstream("ok", { url: "https://" + host + "/asset?signature=value" }) });
    assert.equal((await handler(request(), ADDRESS)).status, 200);
  }
  for (const url of ["https://evil.invalid/asset", "https://github.com.evil.invalid/asset",
    "https://github.com@evil.invalid/asset", "https://raw.githubusercontent.com/asset",
    "https://api.github.com/asset", "http://github.com/asset", "https://github.com:444/asset", "", "not a URL"]) {
    await t.test(url || "missing final URL", async () => {
      let cancelled = false;
      const body = new ReadableStream({ cancel() { cancelled = true; } });
      const { handler, logs } = setup({ fetch: () => upstream(body, { url }) });
      await expectError(await handler(request(), ADDRESS), 502);
      assert.equal(cancelled, true);
      assert.deepEqual(logs, [["relay_error stage=device_pack status=200 kind=redirect"]]);
    });
  }
});

test("404 is passed through and other upstream failures are sanitized and never cached", async (t) => {
  for (const status of [404, 401, 403, 429, 500, 503, 302, 304, 204, 206]) {
    await t.test(String(status), async () => {
      const { handler, calls, logs } = setup({ fetch: () => upstream(
        [204, 304].includes(status) ? null : TOKEN, { status, headers: { ETag: '"error"' } },
      ) });
      for (let n = 0; n < 2; n++) await expectError(await handler(request(), ADDRESS), status === 404 ? 404 : 502);
      assert.equal(calls.length, 2);
      assert.ok(!JSON.stringify(logs).includes(TOKEN));
      if (status === 404) assert.deepEqual(logs, []);
    });
  }
  const { handler, logs } = setup({ fetch: () => { throw new Error(TOKEN + ADDRESS); } });
  await expectError(await handler(request(), ADDRESS), 502);
  assert.deepEqual(logs, [["relay_error stage=device_pack status=0 kind=network"]]);
});

test("each file type accepts its exact byte limit and rejects a larger declared size before reading", async () => {
  for (const [filename, limit] of [[LATEST, 4096], [SIGNATURE, 4096], [VERSION, 256 * 1024]]) {
    const bytes = new Uint8Array(limit).fill(97);
    const exact = setup({ fetch: () => upstream(bytes, { headers: { "Content-Length": String(limit) } }) });
    const response = await exact.handler(request(filename), ADDRESS);
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, limit);
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull() { reads++; }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const tooLarge = setup({ fetch: () => upstream(stream, { headers: { "Content-Length": String(limit + 1) } }) });
    await expectError(await tooLarge.handler(request(filename), ADDRESS), 502);
    assert.equal(reads, 0);
    assert.equal(cancelled, true);
  }
});

test("stream limits catch missing or dishonest lengths, cancel promptly and do not cache failures", async () => {
  for (const [filename, limit] of [[LATEST, 4096], [SIGNATURE, 4096], [VERSION, 256 * 1024]]) {
    for (const headers of [{}, { "Content-Length": "1" }]) {
      let reads = 0;
      let cancelled = false;
      let failing = true;
      const stream = new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(reads++ === 0 ? limit : 1)); },
        cancel() { cancelled = true; return new Promise(() => {}); },
      }, { highWaterMark: 0 });
      const { handler, calls } = setup({ fetch: () => failing ? upstream(stream, { headers }) : upstream("good") });
      await expectError(await handler(request(filename), ADDRESS), 502);
      assert.equal(reads, 2);
      assert.equal(cancelled, true);
      failing = false;
      assert.equal(await (await handler(request(filename), ADDRESS)).text(), "good");
      assert.equal(calls.length, 2);
    }
  }
  const { handler } = setup({ fetch: () => upstream(new Uint8Array(4097)) });
  await expectError(await handler(request(SIGNATURE, { method: "HEAD" }), ADDRESS), 502, { head: true });
});

test("broken upstream body returns a sanitized 502", async () => {
  const { handler, logs } = setup({ fetch: () => upstream(new ReadableStream({
    start(controller) { controller.error(new Error(TOKEN)); },
  })) });
  await expectError(await handler(request(), ADDRESS), 502);
  assert.deepEqual(logs, [["relay_error stage=device_pack status=200 kind=bad_body"]]);
});

test("fetch and response body share a 10 second deadline even if fetch ignores abort", async (t) => {
  for (const stallBody of [false, true]) {
    await t.test(stallBody ? "body stalls" : "fetch stalls", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      let signal;
      let cancelled = false;
      const { handler, logs } = setup({ fetch: (_url, init) => {
        signal = init.signal;
        if (!stallBody) { ready(); return new Promise(() => {}); }
        return upstream(new ReadableStream({
          pull() { ready(); }, cancel() { cancelled = true; return new Promise(() => {}); },
        }, { highWaterMark: 0 }));
      } });
      const pending = handler(request(), ADDRESS);
      await started;
      t.mock.timers.tick(9999);
      assert.equal(signal.aborted, false);
      t.mock.timers.tick(1);
      await expectError(await pending, 502);
      assert.equal(signal.aborted, true);
      assert.equal(cancelled, stallBody);
      assert.deepEqual(logs, [[`relay_error stage=device_pack status=${stallBody ? 200 : 0} kind=timeout`]]);
    });
  }
});

test("late fetch results after timeout cannot populate cache and successful timers are cleared", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ready;
  let release;
  const started = new Promise((resolve) => { ready = resolve; });
  let first = true;
  let cancelled = false;
  const { handler, calls } = setup({ fetch: () => {
    if (!first) return upstream("fresh");
    first = false;
    ready();
    return new Promise((resolve) => { release = resolve; });
  } });
  const pending = handler(request(), ADDRESS);
  await started;
  t.mock.timers.tick(10000);
  await expectError(await pending, 502);
  release(upstream(new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve();
  assert.equal(cancelled, true);
  assert.equal(await (await handler(request(), ADDRESS)).text(), "fresh");
  assert.equal(await (await handler(request(), ADDRESS)).text(), "fresh");
  assert.equal(calls.length, 2);
  t.mock.timers.tick(10000);
  assert.equal(calls[1].signal.aborted, false);
});

test("cache TTL is five minutes for latest and one day for both immutable file types", async () => {
  for (const [filename, ttl] of [[LATEST, 300000], [VERSION, 86400000], [SIGNATURE, 86400000]]) {
    let at = NOW;
    let version = 0;
    const { handler, calls } = setup({ now: () => at, fetch: () => upstream("body-" + ++version) });
    assert.equal(await (await handler(request(filename), ADDRESS)).text(), "body-1");
    at += ttl - 1;
    assert.equal(await (await handler(request(filename), ADDRESS)).text(), "body-1");
    assert.equal(calls.length, 1);
    at++;
    assert.equal(await (await handler(request(filename), ADDRESS)).text(), "body-2");
    assert.equal(calls.length, 2);
  }
});

test("cache holds at most 64 files and evicts oldest insertion even after a cache hit", async () => {
  const { handler, calls } = setup({ fetch: (url) => upstream(url) });
  for (let n = 1; n <= 64; n++) {
    assert.equal((await handler(request(`device-pack-v1-${n}.json`), "client-" + n)).status, 200);
  }
  assert.equal(calls.length, 64);
  assert.equal((await handler(request(VERSION), ADDRESS)).status, 200);
  assert.equal(calls.length, 64);
  assert.equal((await handler(request("device-pack-v1-65.json"), ADDRESS)).status, 200);
  assert.equal(calls.length, 65);
  assert.equal((await handler(request("device-pack-v1-2.json"), ADDRESS)).status, 200);
  assert.equal(calls.length, 65);
  assert.equal(await (await handler(request(VERSION), ADDRESS)).text(), UPSTREAM + VERSION);
  assert.equal(calls.length, 66);
});

test("ETags support exact, weak, list and wildcard conditions on downloads and cache hits", async () => {
  for (const etag of ['"v1"', 'W/"v1"', '"v1,with-comma"']) {
    const { handler, calls } = setup({ fetch: () => upstream("content", { headers: { ETag: etag } }) });
    const opaque = etag.replace(/^W\//, "");
    for (const condition of [etag, opaque, "W/" + opaque, '"other", W/' + opaque, "*"]) {
      const response = await handler(request(VERSION, { headers: { "If-None-Match": condition } }), ADDRESS);
      assert.equal(response.status, 304);
      assert.equal(response.body, null);
      assert.equal(response.headers.get("etag"), etag);
      assert.equal(response.headers.get("cache-control"), "public, max-age=86400, immutable");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("content-type"), "application/json");
      noCors(response);
    }
    assert.equal(calls.length, 1);
    const changed = await handler(request(VERSION, { headers: { "If-None-Match": '"V1"' } }), ADDRESS);
    assert.equal(changed.status, 200);
    assert.equal(await changed.text(), "content");
  }
  const { handler } = setup();
  assert.equal((await handler(request(VERSION, { headers: { "If-None-Match": '"v1"' } }), ADDRESS)).status, 200);
  assert.equal((await handler(request(VERSION, { headers: { "If-None-Match": "*" } }), ADDRESS)).status, 304);
});

test("expired entries are refreshed before evaluating If-None-Match", async () => {
  let at = NOW;
  let version = 0;
  const { handler, calls } = setup({ now: () => at, fetch: () => upstream("content", { headers: { ETag: '"v' + ++version + '"' } }) });
  assert.equal((await handler(request(LATEST), ADDRESS)).headers.get("etag"), '"v1"');
  at += 300000;
  const response = await handler(request(LATEST, { headers: { "If-None-Match": '"v1"' } }), ADDRESS);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"v2"');
  assert.equal(calls.length, 2);
});

test("60 requests per sliding minute includes cache hits, HEAD and 304, with independent addresses", async () => {
  let at = NOW;
  const { handler, calls } = setup({ now: () => at, fetch: () => upstream("ok", { headers: { ETag: '"v1"' } }) });
  for (let n = 0; n < 60; n++) {
    const response = await handler(request(VERSION, {
      method: n % 2 ? "HEAD" : "GET", headers: { "If-None-Match": '"v1"' },
    }), n % 2 ? ADDRESS : { remoteAddr: { hostname: ADDRESS } });
    assert.equal(response.status, 304);
    if (n === 29) at += 30000;
  }
  const blocked = await handler(request(), ADDRESS);
  await expectError(blocked, 429);
  assert.equal(blocked.headers.get("retry-after"), "30");
  assert.equal((await handler(request(), "192.0.2.43")).status, 200);
  at = NOW + 59999;
  const almost = await handler(request(VERSION, { method: "HEAD" }), ADDRESS);
  await expectError(almost, 429, { head: true });
  assert.equal(almost.headers.get("retry-after"), "1");
  at++;
  for (let n = 0; n < 30; n++) assert.equal((await handler(request(), ADDRESS)).status, 200);
  const stillFull = await handler(request(), ADDRESS);
  await expectError(stillFull, 429);
  assert.equal(stillFull.headers.get("retry-after"), "30");
  assert.equal(calls.length, 1);
});

test("unknown addresses share a bucket and forwarded headers cannot bypass mirror limits", async () => {
  const { handler, calls } = setup();
  for (let n = 0; n < 60; n++) {
    const info = [undefined, null, {}, ""][n % 4];
    assert.equal((await handler(request(VERSION, { headers: { "X-Forwarded-For": "client-" + n } }), info)).status, 200);
  }
  await expectError(await handler(request(VERSION, { headers: { "X-Forwarded-For": ADDRESS } })), 429);
  assert.equal((await handler(request(), ADDRESS)).status, 200);
  assert.equal(calls.length, 1);
});

test("failed downloads consume mirror rate quota and invalid names still return 404", async () => {
  const { handler, calls } = setup({ fetch: () => upstream(null, { status: 404 }) });
  for (let n = 0; n < 60; n++) await expectError(await handler(request(), ADDRESS), 404);
  await expectError(await handler(request(), ADDRESS), 429);
  await expectError(await handler(request(LATEST + ".sig"), ADDRESS), 404);
  assert.equal(calls.length, 60);
});

test("concurrent downloads reserve rate quota before fetching", async () => {
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const releases = [];
  const { handler, calls } = setup({ fetch: () => new Promise((resolve) => {
    releases.push(resolve);
    if (releases.length === 60) ready();
  }) });
  const pending = Array.from({ length: 60 }, (_, n) => handler(request(`device-pack-v1-${n + 1}.json`), ADDRESS));
  await started;
  await expectError(await handler(request("device-pack-v1-61.json"), ADDRESS), 429);
  for (const release of releases) release(upstream());
  assert.ok((await Promise.all(pending)).every((response) => response.status === 200));
  assert.equal(calls.length, 60);
});

test("mirror and feedback limits are independent and health remains available", async () => {
  const { handler } = setup({ fetch: (url, init) => {
    if (url.startsWith(UPSTREAM)) return upstream();
    return Response.json(init.method === "POST" ? { number: 1 } : { total_count: 0 });
  } });
  const feedback = () => new Request("https://relay.invalid/feedback", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      schema: 1, category: "device", description: "valid feedback", diagnostics: null, appVersion: "1.2.3",
    }),
  });
  for (let n = 0; n < 60; n++) assert.equal((await handler(request(), ADDRESS)).status, 200);
  await expectError(await handler(request(), ADDRESS), 429);
  for (let n = 0; n < 3; n++) assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  assert.equal((await handler(feedback(), ADDRESS)).status, 429);
  for (let n = 0; n < 3; n++) assert.equal((await handler(feedback(), "192.0.2.43")).status, 201);
  assert.equal((await handler(feedback(), "192.0.2.43")).status, 429);
  assert.equal((await handler(request(), "192.0.2.43")).status, 200);
  assert.deepEqual(await (await handler(new Request("https://relay.invalid/health"))).json(), { ok: true });
});
