import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, mock, test } from "node:test";
import { createHandler } from "../handler.js";

const TOKEN = "test-only-server-secret";
const REPO = "wushuai0802/myfinder-device-battery";
const NOW = Date.parse("2026-11-03T08:30:00.000Z");
const HOUR = 3600000;
const ADDRESS = "192.0.2.42";
const encoder = new TextEncoder();

// Any accidental use of the real network fails locally instead.
before(() => mock.method(globalThis, "fetch", () => {
  throw new Error("Unexpected global fetch; inject a fake fetch in tests");
}));
after(() => mock.restoreAll());

function valid(overrides = {}) {
  return {
    schema: 1,
    category: "device",
    description: "设备无法识别，请检查连接",
    diagnostics: null,
    appVersion: "1.3.5-beta.6",
    ...overrides,
  };
}

function rawFeedback(body, headers = {}) {
  return new Request("https://relay.invalid/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    duplex: "half",
  });
}

function feedback(payload = valid(), headers) {
  return rawFeedback(JSON.stringify(payload), headers);
}

function fakeGithub({ hour = 0, day = 0, number = 37 } = {}) {
  const calls = [];
  let searches = 0;
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url: String(url), ...init });
      if (new URL(url).pathname === "/search/issues") {
        return Response.json({ total_count: searches++ % 2 === 0 ? hour : day });
      }
      return Response.json({
        number,
        url: "https://untrusted.invalid/ignored",
        html_url: "https://untrusted.invalid/also-ignored",
        privateExtra: TOKEN,
      }, { status: 201 });
    },
  };
}

function setup(options = {}) {
  const github = fakeGithub();
  const logs = [];
  return {
    github,
    logs,
    handler: createHandler({
      token: TOKEN, fetch: github.fetch, now: () => NOW, log: (...args) => logs.push(args), ...options,
    }),
  };
}

function expectLog(logs, stage, status, kind, times = 1) {
  assert.deepEqual(logs, Array.from({ length: times }, () => [
    `relay_error stage=${stage} status=${status} kind=${kind}`,
  ]));
}

function noCors(response) {
  for (const [name] of response.headers) assert.ok(!name.startsWith("access-control-"));
  assert.match(response.headers.get("content-type"), /^application\/json/);
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  noCors(response);
  assert.deepEqual(await response.json(), { error: code });
  if (status === 429) {
    assert.match(response.headers.get("retry-after"), /^\d+$/);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
  }
}

function issueCalls(github) {
  return github.calls.filter((call) => call.method === "POST");
}

function captureAddressTable(t, options) {
  const NativeMap = globalThis.Map;
  let table;
  t.mock.method(globalThis, "Map", function (...args) {
    table = new NativeMap(...args);
    return table;
  });
  const handler = createHandler(options);
  t.mock.restoreAll();
  assert.ok(table instanceof NativeMap);
  return { handler, table };
}

test("health, unknown paths and unsupported methods work without GitHub or CORS", async () => {
  const { handler, github, logs } = setup({ token: undefined });
  const health = await handler(new Request("https://relay.invalid/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  noCors(health);
  for (const path of ["/", "/missing", "/feedback/", "/health/"]) {
    await expectError(await handler(new Request("https://relay.invalid" + path)), 404, "invalid");
  }
  for (const method of ["GET", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    const response = await handler(new Request("https://relay.invalid/feedback", { method }));
    assert.equal(response.headers.get("allow"), "POST");
    await expectError(response, 405, "invalid");
  }
  const response = await handler(new Request("https://relay.invalid/health", { method: "POST" }));
  assert.equal(response.headers.get("allow"), "GET");
  await expectError(response, 405, "invalid");
  assert.equal(github.calls.length, 0);
  assert.deepEqual(logs, []);
});

test("all categories and legal field boundaries are accepted", async (t) => {
  const cases = [
    ...["device", "battery", "ui", "other"].map((category) => ({ category })),
    { description: "  abcde \r\n" },
    { description: "x".repeat(2000) },
    { description: "😀".repeat(2000) },
    { diagnostics: "" },
    { diagnostics: "x".repeat(20000) },
    { diagnostics: "诊断信息\r\n包含制表符\t" },
    { appVersion: "1.2.3" },
    { appVersion: "001.02.3-Az09.rc.1" },
    { appVersion: "1.2.3-" + "a".repeat(26) },
  ];
  for (const [index, overrides] of cases.entries()) {
    await t.test("legal case " + index, async () => {
      const { handler, github, logs } = setup();
      const response = await handler(feedback(valid(overrides)), ADDRESS);
      assert.equal(response.status, 201);
      noCors(response);
      const issue = JSON.parse(issueCalls(github)[0].body);
      const names = { device: "设备不识别", battery: "电量或 DPI 不对", ui: "界面或操作", other: "其他" };
      assert.ok(issue.title.startsWith("[程序内反馈] " + names[overrides.category || "device"] + "："));
      assert.deepEqual(logs, []);
    });
  }
});

test("wrong types, missing/extra fields and invalid values never call fetch", async (t) => {
  const cases = [
    ...[0, 2, "1", null, true, {}, []].map((schema) => valid({ schema })),
    ...["unknown", "DEVICE", "constructor", "__proto__", "toString", "", null, 1, {}]
      .map((category) => valid({ category })),
    ...["", " \r\n\t ", "abcd", "x".repeat(2001), "😀".repeat(2001), null, 5, true, [], {}]
      .map((description) => valid({ description })),
    ...["x".repeat(20001), false, 0, [], {}].map((diagnostics) => valid({ diagnostics })),
    ...["", "1.2", "v1.2.3", "1.2.3.4", "1.2.3-", "1.2.3-a_b", "1.2.3+build", "1.2.3\n",
      "1.2.3\r\n", "1.2.3 ", "1.2.3-" + "a".repeat(27), null, 123, [], {}]
      .map((appVersion) => valid({ appVersion })),
    valid({ extra: "not allowed" }),
    null, [], {}, "text", 1, true,
  ];
  for (const field of Object.keys(valid())) {
    const payload = valid();
    delete payload[field];
    cases.push(payload);
  }
  for (const [index, payload] of cases.entries()) {
    await t.test("invalid case " + index, async () => {
      const { handler, github, logs } = setup();
      await expectError(await handler(feedback(payload), ADDRESS), 400, "invalid");
      assert.equal(github.calls.length, 0);
      assert.deepEqual(logs, []);
    });
  }
});

test("non-JSON, missing/wrong media types and failed request streams are sanitized", async () => {
  const { handler, github } = setup();
  for (const body of ["", "not json", "{", "{\"schema\":1,}"]) {
    await expectError(await handler(rawFeedback(body), ADDRESS), 400, "invalid");
  }
  for (const type of ["text/plain", "application/jsonp", ""]) {
    await expectError(await handler(feedback(valid(), { "Content-Type": type }), ADDRESS), 400, "invalid");
  }
  const missingType = feedback();
  missingType.headers.delete("content-type");
  await expectError(await handler(missingType, ADDRESS), 400, "invalid");
  await expectError(await handler(rawFeedback(new Uint8Array([0xff, 0xfe])), ADDRESS), 400, "invalid");
  await expectError(await handler(new Request("https://relay.invalid/feedback", {
    method: "POST", headers: { "Content-Type": "application/json" },
  }), ADDRESS), 400, "invalid");
  const broken = new ReadableStream({
    start(controller) { controller.error(new Error(TOKEN + ADDRESS + valid().description)); },
  });
  await expectError(await handler(rawFeedback(broken), ADDRESS), 400, "invalid");
  assert.equal(github.calls.length, 0);
  const response = await handler(feedback(valid(), { "Content-Type": "Application/JSON; charset=utf-8" }), ADDRESS);
  assert.equal(response.status, 201);
});

test("Content-Length rejects oversize bodies before reading, including huge numbers", async () => {
  const { handler, github, logs } = setup();
  for (const length of ["32769", "999999999999999999999999999999999999"]) {
    let reads = 0;
    const stream = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
    await expectError(await handler(rawFeedback(stream, { "Content-Length": length }), ADDRESS), 413, "too_large");
    assert.equal(reads, 0);
  }
  for (const length of ["-1", "1.5", "unknown"]) {
    await expectError(await handler(feedback(valid(), { "Content-Length": length }), ADDRESS), 400, "invalid");
  }
  assert.equal(github.calls.length, 0);
  assert.deepEqual(logs, []);
});

test("actual byte limit is inclusive and enforced for absent or dishonest Content-Length", async () => {
  const raw = JSON.stringify(valid());
  const exact = raw + " ".repeat(32768 - encoder.encode(raw).byteLength);
  const { handler, github, logs } = setup();
  assert.equal((await handler(rawFeedback(exact, { "Content-Length": "32768" }), ADDRESS)).status, 201);
  await expectError(await handler(rawFeedback(exact + " "), ADDRESS), 413, "too_large");
  await expectError(await handler(rawFeedback(exact + " ", { "Content-Length": "1" }), ADDRESS), 413, "too_large");
  const multibyte = JSON.stringify(valid({ description: "字".repeat(2000), diagnostics: "字".repeat(10000) }));
  assert.ok(multibyte.length < 32768);
  assert.ok(encoder.encode(multibyte).byteLength > 32768);
  await expectError(await handler(rawFeedback(multibyte), ADDRESS), 413, "too_large");
  assert.equal(issueCalls(github).length, 1);
  assert.deepEqual(logs, []);
});

test("streamed bodies stop reading and cancel when accumulated bytes exceed the limit", async () => {
  const { handler, github } = setup();
  const chunks = [encoder.encode(" ".repeat(20000)), encoder.encode(" ".repeat(13000)), encoder.encode("never read")];
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(chunks[reads++]); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await expectError(await handler(rawFeedback(stream), ADDRESS), 413, "too_large");
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  assert.equal(github.calls.length, 0);
});

test("titles neutralize mentions and issue references; independent fences isolate untrusted text", async () => {
  const { handler, github } = setup();
  const description = "  @user #1 ![x](http://a)\u0000\u0007\r\n```\n````\n保留\t制表\u000b\u0085  ";
  const diagnostics = "@user #1\r\n![x](http://a)\n``````\n</details>\u001b\u007f";
  assert.equal((await handler(feedback(valid({ description, diagnostics })), ADDRESS)).status, 201);
  const issue = JSON.parse(issueCalls(github)[0].body);
  assert.equal(issue.title, "[程序内反馈] 设备不识别：＠user ＃1 ![x](http://a)");
  const expectedDescription = "@user #1 ![x](http://a)\n```\n````\n保留\t制表";
  const expectedDiagnostics = "@user #1\n![x](http://a)\n``````\n</details>";
  const fence = "`".repeat(5);
  const diagnosticFence = "`".repeat(7);
  assert.equal(issue.body,
    "来自程序内反馈 · 版本 1.3.5-beta.6\n\n**类型**：设备不识别\n\n**描述**\n"
    + fence + "\n" + expectedDescription + "\n" + fence
    + "\n\n<details><summary>诊断信息</summary>\n\n"
    + diagnosticFence + "\n" + expectedDiagnostics + "\n" + diagnosticFence + "\n\n</details>");
  assert.deepEqual(issue.labels, ["in-app-feedback"]);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(issue.body));
});

test("title truncation respects Unicode characters and omits diagnostic details when absent", async () => {
  for (const diagnostics of [null, ""]) {
    const { handler, github } = setup();
    await handler(feedback(valid({ description: "😀".repeat(45) + "\nsecond line @ignored", diagnostics })), ADDRESS);
    const issue = JSON.parse(issueCalls(github)[0].body);
    assert.equal(issue.title, "[程序内反馈] 设备不识别：" + "😀".repeat(40));
    assert.ok(Array.from(issue.title).length <= 120);
    assert.ok(!issue.body.includes("<details>"));
    assert.ok(issue.body.includes("\n```\n"));
  }
});

test("GitHub URLs, headers, methods, label and UTC searches match the configured repository", async () => {
  const repo = "example-owner/another-repo";
  const { handler, github } = setup({ repo });
  const response = await handler(feedback(), { remoteAddr: { hostname: ADDRESS } });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { number: 37, url: "https://github.com/" + repo + "/issues/37" });
  assert.equal(github.calls.length, 3);
  const queries = github.calls.slice(0, 2).map((call) => {
    const url = new URL(call.url);
    assert.equal(url.origin + url.pathname, "https://api.github.com/search/issues");
    assert.equal(call.method, "GET");
    return url.searchParams.get("q");
  });
  assert.deepEqual(queries, [
    "repo:" + repo + " is:issue label:in-app-feedback created:>=2026-11-03T07:30:00.000Z",
    "repo:" + repo + " is:issue label:in-app-feedback created:>=2026-11-02T08:30:00.000Z",
  ]);
  const issue = github.calls[2];
  assert.equal(issue.url, "https://api.github.com/repos/" + repo + "/issues");
  assert.equal(issue.method, "POST");
  assert.equal(new Headers(issue.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(issue.body).labels, ["in-app-feedback"]);
  for (const call of github.calls) {
    const headers = new Headers(call.headers);
    assert.equal(headers.get("authorization"), "Bearer " + TOKEN);
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("x-github-api-version"), "2022-11-28");
    assert.equal(headers.get("user-agent"), "myfinder-feedback-relay");
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(call.signal.aborted, false);
    assert.ok(!JSON.stringify({ url: call.url, body: call.body, headers: call.headers }).includes(ADDRESS));
  }
});

test("both global searches include is:issue for fine-grained tokens", async () => {
  const github = fakeGithub();
  const queries = [];
  const { handler, logs } = setup({ fetch: (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/search/issues") {
      const qualifiers = parsed.searchParams.get("q").split(/\s+/);
      queries.push(qualifiers);
      if (!qualifiers.includes("is:issue")) return new Response(null, { status: 422 });
    }
    return github.fetch(url, init);
  } });
  const response = await handler(feedback(), ADDRESS);
  assert.equal(queries.length, 2);
  for (const qualifiers of queries) assert.ok(qualifiers.includes("is:issue"));
  assert.equal(response.status, 201);
  assert.equal(issueCalls(github).length, 1);
  assert.deepEqual(logs, []);
});

test("token whitespace is trimmed before every GitHub Authorization header", async () => {
  const { handler, github, logs } = setup({ token: " \t\r\n" + TOKEN + "\n\t " });
  assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  assert.equal(github.calls.length, 3);
  for (const call of github.calls) assert.equal(call.headers.Authorization, "Bearer " + TOKEN);
  assert.deepEqual(logs, []);
});

test("successful response uses the default repo and only a safe issue number plus generated URL", async () => {
  const { handler } = setup();
  const response = await handler(feedback(), ADDRESS);
  noCors(response);
  assert.deepEqual(await response.json(), { number: 37, url: "https://github.com/" + REPO + "/issues/37" });
});

test("per-address quota rejects the fourth success and recovers exactly one hour later", async () => {
  let at = NOW;
  const { handler, github, logs } = setup({ now: () => at });
  for (let n = 0; n < 3; n++) assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  const before = github.calls.length;
  const fourth = await handler(feedback(), ADDRESS);
  assert.equal(fourth.headers.get("retry-after"), "3600");
  await expectError(fourth, 429, "rate_limited");
  assert.equal(github.calls.length, before);
  assert.equal((await handler(feedback(), "192.0.2.43")).status, 201);
  at += HOUR - 1;
  const almost = await handler(feedback(), ADDRESS);
  assert.equal(almost.headers.get("retry-after"), "1");
  await expectError(almost, 429, "rate_limited");
  at++;
  assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  assert.deepEqual(logs, []);
});

test("the address window slides instead of resetting all successes at once", async () => {
  let at = NOW;
  const { handler } = setup({ now: () => at });
  assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  at += HOUR / 2;
  for (let n = 0; n < 2; n++) assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  at = NOW + HOUR;
  assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  const response = await handler(feedback(), ADDRESS);
  assert.equal(response.headers.get("retry-after"), "1800");
  await expectError(response, 429, "rate_limited");
});

test("missing addresses share a bucket and forwarded headers cannot bypass it", async () => {
  const { handler, github } = setup();
  for (const info of [undefined, {}, ""]) {
    assert.equal((await handler(feedback(valid(), { "X-Forwarded-For": "192.0.2." + github.calls.length }), info)).status, 201);
  }
  await expectError(await handler(feedback(valid(), { "X-Forwarded-For": ADDRESS }), null), 429, "rate_limited");
  assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  assert.equal((await handler(feedback(), { remoteAddr: { hostname: ADDRESS } })).status, 201);
});

test("invalid requests do not spend the address quota or call GitHub even at the limit", async () => {
  const { handler, github } = setup();
  for (let n = 0; n < 4; n++) await expectError(await handler(feedback(valid({ schema: 2 })), ADDRESS), 400, "invalid");
  assert.equal(github.calls.length, 0);
  for (let n = 0; n < 3; n++) assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  await expectError(await handler(feedback(valid({ description: "" })), ADDRESS), 400, "invalid");
  assert.equal(github.calls.length, 9);
  await expectError(await handler(feedback(), ADDRESS), 429, "rate_limited");
});

test("concurrent submissions reserve address quota before network work", async () => {
  let ready;
  const allStarted = new Promise((resolve) => { ready = resolve; });
  const releases = [];
  const normal = fakeGithub();
  const { handler } = setup({ fetch: async (url, init) => {
    if (init.method !== "POST") return normal.fetch(url, init);
    return new Promise((resolve) => {
      releases.push(resolve);
      if (releases.length === 3) ready();
    });
  } });
  const pending = Array.from({ length: 3 }, () => handler(feedback(), ADDRESS));
  await allStarted;
  await expectError(await handler(feedback(), ADDRESS), 429, "rate_limited");
  for (const release of releases) release(Response.json({ number: 1 }));
  assert.deepEqual((await Promise.all(pending)).map((response) => response.status), [201, 201, 201]);
  await expectError(await handler(feedback(), ADDRESS), 429, "rate_limited");
});

test("address storage contains only SHA-256 keys and drops expired entries", async (t) => {
  let at = NOW;
  const github = fakeGithub();
  const { handler, table } = captureAddressTable(t, { token: TOKEN, fetch: github.fetch, now: () => at });
  await handler(feedback(), ADDRESS);
  const hash = createHash("sha256").update("address:" + ADDRESS).digest("hex");
  assert.deepEqual([...table.keys()], [hash]);
  assert.ok(/^[a-f0-9]{64}$/.test(hash));
  const stored = JSON.stringify([...table]);
  for (const secret of [ADDRESS, TOKEN, valid().description]) assert.ok(!stored.includes(secret));
  assert.equal(stored.includes("192.0.2.43"), false);
  at += HOUR;
  await handler(feedback(), "192.0.2.43");
  assert.equal(table.has(hash), false);
  assert.equal(table.size, 1);
});

test("address table caps at 10000, permits existing addresses, then reclaims expiry", async (t) => {
  let at = NOW;
  let calls = 0;
  const { handler, table } = captureAddressTable(t, {
    token: TOKEN, now: () => at,
    fetch: async (_url, init) => {
      calls++;
      return Response.json(init.method === "POST" ? { number: 1 } : { total_count: 0 });
    },
  });
  for (let n = 0; n < 10000; n++) {
    assert.equal((await handler(feedback(), "client-" + n)).status, 201);
  }
  assert.equal(table.size, 10000);
  const before = calls;
  await expectError(await handler(feedback(), "new-client"), 429, "rate_limited");
  assert.equal(calls, before);
  assert.equal((await handler(feedback(), "client-0")).status, 201);
  assert.equal(table.size, 10000);
  at += HOUR;
  assert.equal((await handler(feedback(), "new-client")).status, 201);
  assert.equal(table.size, 1);
});

test("both global thresholds are enforced before creating an issue", async (t) => {
  for (const [hour, day, status, retry] of [[19, 199, 201], [20, 20, 429, "3600"], [21, 199, 429, "3600"], [0, 200, 429, "86400"], [19, 201, 429, "86400"]]) {
    await t.test("counts " + hour + "/" + day, async () => {
      const github = fakeGithub({ hour, day });
      const { handler, logs } = setup({ fetch: github.fetch });
      const response = await handler(feedback(), ADDRESS);
      if (status === 429) {
        assert.equal(response.headers.get("retry-after"), retry);
        await expectError(response, 429, "rate_limited");
        assert.equal(issueCalls(github).length, 0);
      } else assert.equal(response.status, status);
      assert.equal(github.calls.filter((call) => call.method === "GET").length, 2);
      assert.deepEqual(logs, []);
    });
  }
});

test("search failures and malformed/incomplete search responses fail closed", async (t) => {
  const badSearches = [
    [() => { throw new Error(TOKEN + ADDRESS); }, 0, "network"],
    [() => new Response(TOKEN, { status: 401 }), 401, "http"],
    [() => new Response(TOKEN, { status: 403 }), 403, "http"],
    [() => new Response("not JSON"), 200, "bad_body"],
    [() => Response.json({}), 200, "bad_body"],
    [() => Response.json({ total_count: -1 }), 200, "bad_body"],
    [() => Response.json({ total_count: "0" }), 200, "bad_body"],
    [() => Response.json({ total_count: 0.5 }), 200, "bad_body"],
    [() => Response.json({ total_count: 0, incomplete_results: true }), 200, "bad_body"],
  ];
  for (const [index, [badSearch, status, kind]] of badSearches.entries()) {
    for (const failingSearch of [0, 1]) {
      await t.test("failure " + index + " in search " + failingSearch, async () => {
        let searches = 0;
        let posts = 0;
        const { handler, logs } = setup({ fetch: async (_url, init) => {
          if (init.method === "POST") { posts++; return Response.json({ number: 1 }); }
          return searches++ === failingSearch ? badSearch() : Response.json({ total_count: 0 });
        } });
        await expectError(await handler(feedback(), ADDRESS), 502, "unavailable");
        assert.equal(searches, 2);
        assert.equal(posts, 0);
        expectLog(logs, failingSearch === 0 ? "search_hour" : "search_day", status, kind);
      });
    }
  }
});

test("failed issue creation and unsafe numbers are sanitized and do not spend quota", async (t) => {
  const failures = [
    [() => { throw new Error(TOKEN + ADDRESS + valid().description); }, 0, "network"],
    [() => new Response(TOKEN, { status: 401 }), 401, "http"],
    [() => new Response(TOKEN, { status: 403 }), 403, "http"],
    [() => new Response(TOKEN, { status: 500 }), 500, "http"],
    [() => new Response("not JSON", { status: 201 }), 201, "bad_body"],
    ...[null, {}, { number: "1" }, { number: 0 }, { number: -1 }, { number: 1.5 }, { number: Number.MAX_SAFE_INTEGER + 1 }]
      .map((body) => [() => Response.json(body, { status: 201 }), 201, "bad_body"]),
  ];
  for (const [index, [fail, status, kind]] of failures.entries()) {
    await t.test("issue failure " + index, async () => {
      let failing = true;
      const github = fakeGithub();
      const { handler, logs } = setup({ fetch: (url, init) => {
        if (failing && init.method === "POST") return fail();
        return github.fetch(url, init);
      } });
      for (let n = 0; n < 4; n++) await expectError(await handler(feedback(), ADDRESS), 502, "unavailable");
      expectLog(logs, "create", status, kind, 4);
      failing = false;
      for (let n = 0; n < 3; n++) assert.equal((await handler(feedback(), ADDRESS)).status, 201);
      await expectError(await handler(feedback(), ADDRESS), 429, "rate_limited");
      expectLog(logs, "create", status, kind, 4);
    });
  }
});

test("searches time out at 10 seconds, abort both signals and release address reservations", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stalled = true;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const signals = [];
  const normal = fakeGithub();
  const { handler, logs } = setup({ fetch: (url, init) => {
    if (!stalled) return normal.fetch(url, init);
    signals.push(init.signal);
    if (signals.length === 2) ready();
    // A fake that ignores abort still cannot keep the handler pending forever.
    return new Promise(() => {});
  } });
  const pending = handler(feedback(), ADDRESS);
  await started;
  t.mock.timers.tick(9999);
  assert.ok(signals.every((signal) => !signal.aborted));
  t.mock.timers.tick(1);
  await expectError(await pending, 502, "unavailable");
  assert.ok(signals.every((signal) => signal.aborted));
  expectLog(logs, "search_hour", 0, "timeout");
  stalled = false;
  for (let n = 0; n < 3; n++) assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  t.mock.timers.tick(10000);
  assert.ok(normal.calls.every((call) => !call.signal.aborted));
  await expectError(await handler(feedback(), ADDRESS), 429, "rate_limited");
  expectLog(logs, "search_hour", 0, "timeout");
});

test("issue creation and stalled response bodies share the 10 second abort deadline", async (t) => {
  for (const stallBody of [false, true]) {
    await t.test(stallBody ? "body stalls" : "fetch stalls", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      let signal;
      const github = fakeGithub();
      const { handler, logs } = setup({ fetch: (url, init) => {
        if (init.method !== "POST") return github.fetch(url, init);
        signal = init.signal;
        if (stallBody) return { ok: true, status: 201, json: () => {
          ready();
          return new Promise(() => {});
        } };
        ready();
        return new Promise((_, reject) => signal.addEventListener("abort", () => {
          reject(new Error(TOKEN + ADDRESS + valid().description));
        }, { once: true }));
      } });
      const pending = handler(feedback(), ADDRESS);
      await started;
      t.mock.timers.tick(9999);
      assert.equal(signal.aborted, false);
      t.mock.timers.tick(1);
      await expectError(await pending, 502, "unavailable");
      assert.equal(signal.aborted, true);
      expectLog(logs, "create", stallBody ? 201 : 0, "timeout");
    });
  }
});

test("missing token and disabled mode return 503 without network work", async () => {
  for (const options of [{ token: undefined }, { token: null }, { token: "" }, { token: " \t\r\n " }, { disabled: true }]) {
    const { handler, github, logs } = setup(options);
    await expectError(await handler(feedback(), ADDRESS), 503, "disabled");
    assert.equal(github.calls.length, 0);
    const health = await handler(new Request("https://relay.invalid/health"));
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"ok":true}');
    assert.deepEqual(logs, []);
  }
});

test("default console.error logs only one safe line and never logs private data", async (t) => {
  const secrets = [TOKEN, ADDRESS, valid().description, "private-diagnostics", "private-header", "private-github-body"];
  const privateText = secrets.join("\n");
  const cases = [
    {
      name: "network exception", stage: "search_hour", status: 0, kind: "network",
      options: { fetch: () => { throw new Error(privateText); } },
    },
    {
      name: "GitHub error body", stage: "search_hour", status: 401, kind: "http",
      options: { fetch: () => new Response(privateText, { status: 401 }) },
    },
    {
      name: "malformed GitHub JSON", stage: "create", status: 201, kind: "bad_body",
      options: { fetch: (_url, init) => init.method === "POST"
        ? new Response(privateText, { status: 201 }) : Response.json({ total_count: 0 }) },
    },
    {
      name: "invalid GitHub issue body", stage: "create", status: 201, kind: "bad_body",
      options: { fetch: (_url, init) => init.method === "POST"
        ? Response.json({ number: privateText }, { status: 201 }) : Response.json({ total_count: 0 }) },
    },
    {
      name: "unexpected exception", stage: "unexpected", status: 0, kind: "unexpected",
      options: { now: () => { throw new Error(privateText); } },
    },
    {
      name: "untrusted error fields", stage: "unexpected", status: 0, kind: "unexpected",
      options: { now: () => { throw { stage: privateText, status: privateText, kind: privateText }; } },
    },
  ];
  for (const { name, options, stage, status, kind } of cases) {
    await t.test(name, async (t) => {
      const logged = [];
      for (const method of ["log", "info", "warn", "error", "debug"]) {
        t.mock.method(console, method, (...args) => logged.push([method, ...args]));
      }
      const github = fakeGithub();
      const handler = createHandler({ token: TOKEN, fetch: github.fetch, now: () => NOW, ...options });
      const response = await handler(feedback(valid({ diagnostics: secrets[3] }), { "X-Private": secrets[4] }), ADDRESS);
      const text = await response.text();
      assert.equal(response.status, 502);
      assert.equal(text, '{"error":"unavailable"}');
      assert.deepEqual(logged, [["error", `relay_error stage=${stage} status=${status} kind=${kind}`]]);
      for (const secret of secrets) {
        assert.ok(!text.includes(secret));
        assert.ok(!JSON.stringify([...response.headers]).includes(secret));
        assert.ok(!JSON.stringify(logged).includes(secret));
      }
    });
  }
});

test("a failing injected logger preserves the 502 response and is called only once", async () => {
  let calls = 0;
  const { handler } = setup({
    fetch: () => { throw new Error(TOKEN); },
    log: () => { calls++; throw new Error(TOKEN + ADDRESS); },
  });
  await expectError(await handler(feedback(), ADDRESS), 502, "unavailable");
  assert.equal(calls, 1);
});

test("default global fetch and Date.now remain injectable for portable runtimes", async (t) => {
  const github = fakeGithub();
  t.mock.method(globalThis, "fetch", github.fetch);
  t.mock.method(Date, "now", () => NOW);
  const handler = createHandler({ token: TOKEN });
  assert.equal((await handler(feedback(), ADDRESS)).status, 201);
  assert.ok(github.calls[0].url.includes("2026-11-03T07%3A30%3A00.000Z"));
});

test("Deno entry point can be imported under Node without starting a server", async () => {
  await assert.doesNotReject(import("../main.js"));
});
