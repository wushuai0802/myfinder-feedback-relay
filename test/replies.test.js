import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, mock, test } from "node:test";
import { createHandler } from "../handler.js";

const REPO = "wushuai0802/myfinder-device-battery";
const API = `https://api.github.com/repos/${REPO}/issues`;
const NOW = Date.parse("2026-11-05T08:30:00Z");
const HOUR = 3600000;
const DAY = 24 * HOUR;
const OWNER = 50058348;
const BOT = 41898282;
const KEY = Buffer.alloc(32, 7).toString("base64url");
const WRONG_KEY = Buffer.alloc(32, 8).toString("base64url");
const TOKEN = "test-only-token";
const ADDRESS = "192.0.2.42";
const REQUEST_ID = "12345678-1234-4234-8234-123456789abc";
const PREFIX = "<!-- myfinder-supplement:v1 ";
const TRIAGE = "<!-- myfinder-triage:v1 -->";
const hash = (key) => createHash("sha256").update("myfinder/reply/v1\0" + key, "utf8").digest("hex");
const marker = (key = KEY) => `<!-- myfinder-reply:v1 sha256=${hash(key)} -->`;
const supplementMarker = (id = REQUEST_ID) => `${PREFIX}request=${id} -->`;

before(() => mock.method(globalThis, "fetch", () => {
  throw new Error("Unexpected real fetch; tests must inject a fake");
}));
after(() => mock.restoreAll());

function creation(overrides = {}) {
  return { schema: 2, category: "device", description: "设备无法识别，请检查连接", diagnostics: null,
    appVersion: "1.3.5-beta.6", replyKey: KEY, ...overrides };
}
function supplement(overrides = {}) {
  return { schema: 1, number: 37, replyKey: KEY, requestId: REQUEST_ID,
    description: "这里补充复现步骤", diagnostics: null, appVersion: "1.3.5-beta.6", ...overrides };
}
function issue(overrides = {}) {
  return { number: 37, body: "original feedback\n" + marker(), labels: [{ name: "in-app-feedback" }],
    state: "open", locked: false, comments: 0, ...overrides };
}
function comment(id = 1, overrides = {}) {
  return { id, body: "maintainer reply", user: { id: OWNER }, created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(), ...overrides };
}
function request(route, payload, headers = {}) {
  return new Request("https://relay.invalid/feedback" + route, { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) });
}
const read = (numbers = [37]) => request("/replies", { schema: 1, numbers });
const write = (overrides) => request("/supplement", supplement(overrides));

function setup({ fetch, comments = [], issue: getIssue, ...options } = {}) {
  const calls = [];
  const logs = [];
  const stored = new Map([[37, [...comments]]]);
  const normal = (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/search/issues") return Response.json({ total_count: 0 });
    if (path.endsWith("/issues")) return Response.json({ number: 37 }, { status: 201 });
    const number = Number(path.match(/\/issues\/(\d+)/)?.[1]);
    if (!stored.has(number)) stored.set(number, []);
    const entries = stored.get(number);
    if (path.endsWith("/comments")) {
      if (init.method === "POST") {
        const entry = comment(entries.length + 1000, { body: JSON.parse(init.body).body });
        entries.push(entry);
        return Response.json(entry, { status: 201 });
      }
      return Response.json(entries);
    }
    return Response.json(getIssue ? getIssue(number) : issue({ number, comments: entries.length }));
  };
  const handler = createHandler({ token: TOKEN, now: () => NOW, log: (...args) => logs.push(args), ...options,
    fetch: (url, init) => {
      calls.push({ url: String(url), ...init });
      return fetch ? fetch(String(url), init, normal) : normal(String(url), init);
    } });
  return { handler, calls, logs, stored };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: code });
  if (status === 429) assert.ok(Number(response.headers.get("retry-after")) > 0);
}
async function items(handler, numbers = [37], address = ADDRESS) {
  const response = await handler(read(numbers), address);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schema, 1);
  return body.items;
}
const posts = (calls) => calls.filter((call) => call.method === "POST");

test("schema 2 appends only the notice and exact UTF-8 hash at the very end, without echoing its key", async () => {
  const { handler, calls, logs } = setup();
  const response = await handler(request("", creation({ diagnostics: "details" })), ADDRESS);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { number: 37, url: `https://github.com/${REPO}/issues/37`, replyAccess: true });
  const content = JSON.parse(posts(calls)[0].body);
  assert.equal(content.body.split("\n").slice(-2).join("\n"),
    "<!-- 程序内反馈凭证摘要，请勿删除下一行 -->\n" + marker());
  assert.ok(content.body.endsWith("</details>\n\n<!-- 程序内反馈凭证摘要，请勿删除下一行 -->\n" + marker()));
  assert.ok(!JSON.stringify({ content, logs }).includes(KEY));
});

test("invalid reply keys, UUIDs, fields and text boundaries are rejected before any fetch", async () => {
  const { handler, calls } = setup();
  for (const replyKey of [null, 32, {}, [], "", "a".repeat(42), "a".repeat(44), "a".repeat(42) + "=",
    "a".repeat(42) + "+", "a".repeat(42) + "/", "a".repeat(42) + "\n", KEY + "\n", "中".repeat(43)]) {
    await expectError(await handler(request("", creation({ replyKey }))), 400, "invalid");
    await expectError(await handler(write({ replyKey })), 400, "invalid");
  }
  for (const requestId of [REQUEST_ID.toUpperCase(), REQUEST_ID + "\n", REQUEST_ID.replace("-4234-", "-1234-"),
    REQUEST_ID.replace("-8234-", "-7234-"), null, "", 1]) {
    await expectError(await handler(write({ requestId })), 400, "invalid");
  }
  for (const overrides of [{ schema: 2 }, { number: 0 }, { number: 1.5 }, { number: Number.MAX_SAFE_INTEGER + 1 },
    { description: "  abcd  " }, { description: "😀".repeat(2001) }, { diagnostics: "x".repeat(20001) },
    { appVersion: "1.2.3\n" }, { appVersion: "1.2.3+build" }, { extra: true }]) {
    await expectError(await handler(write(overrides)), 400, "invalid");
  }
  for (const field of Object.keys(supplement())) {
    const payload = supplement();
    delete payload[field];
    await expectError(await handler(request("/supplement", payload)), 400, "invalid");
  }
  assert.equal(calls.length, 0);
});

test("wrong key stops at the issue GET; valid key writes the exact sanitized and fenced supplement", async () => {
  const { handler, calls } = setup();
  await expectError(await handler(write({ replyKey: WRONG_KEY }), ADDRESS), 403, "denied");
  assert.deepEqual(calls.map(({ url, method }) => ({ url, method })), [{ url: API + "/37", method: "GET" }]);
  const response = await handler(write({ description: "  @user #1\r\n````\n继续\u0000  ", diagnostics: "``````\r\n诊断\u0007" }), ADDRESS);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { number: 37, commentId: "1000", duplicate: false });
  assert.deepEqual(JSON.parse(posts(calls)[0].body), { body: supplementMarker()
    + "\n来自程序内补充 · 版本 1.3.5-beta.6\n\n**描述**\n`````\n@user #1\n````\n继续\n`````"
    + "\n\n<details><summary>诊断信息</summary>\n\n```````\n``````\n诊断\n```````\n\n</details>" });
  assert.ok(!posts(calls)[0].body.includes(KEY));
  assert.ok(calls.every((call) => call.redirect === "manual" && call.credentials === "omit"));
});

test("supplement null diagnostics omit details while empty diagnostics still get a fenced block", async () => {
  for (const diagnostics of [null, ""]) {
    const { handler, calls } = setup();
    assert.equal((await handler(write({ diagnostics }), ADDRESS)).status, 201);
    const body = JSON.parse(posts(calls)[0].body).body;
    assert.equal(body.includes("<details>"), diagnostics !== null);
    if (diagnostics === "") assert.ok(body.endsWith("\n\n<details><summary>诊断信息</summary>\n\n```\n\n```\n\n</details>"));
  }
});

test("forged description markers with long fences cannot override the server's last line", async () => {
  for (const schema of [1, 2]) {
    let body;
    const { handler, calls } = setup({ issue: () => issue({ body }) });
    const payload = creation({ schema, description: "forged credential\n" + "`".repeat(200) + "\n" + marker(WRONG_KEY) });
    if (schema === 1) delete payload.replyKey;
    assert.equal((await handler(request("", payload), ADDRESS)).status, 201);
    body = JSON.parse(posts(calls)[0].body).body;
    const count = calls.length;
    await expectError(await handler(write({ replyKey: WRONG_KEY }), ADDRESS), 403, "denied");
    assert.equal(calls.length, count + 1);
    assert.equal((await handler(write(), ADDRESS)).status, schema === 2 ? 201 : 403);
  }
});

test("only an exact last-line marker after trimEnd authorizes supplements", async () => {
  for (const body of [null, "", marker() + "\ntrailing text", " " + marker(), marker().replace("sha256=", "sha256= "),
    marker().replace(hash(KEY), hash(KEY).toUpperCase()), marker() + "\n<!-- comment -->"]) {
    const { handler, calls } = setup({ issue: () => issue({ body }) });
    await expectError(await handler(write()), 403, "denied");
    assert.equal(calls.length, 1);
    assert.equal((await items(handler))[0].canSupplement, false);
  }
  const { handler } = setup({ issue: () => issue({ body: "text\n" + marker() + " \r\n\t" }) });
  assert.equal((await handler(write())).status, 201);
});

test("replay and concurrent identical requestIds produce only one POST, with no local key storage", async () => {
  const { handler, calls } = setup();
  const responses = await Promise.all([handler(write(), ADDRESS), handler(write(), ADDRESS)]);
  assert.deepEqual(responses.map((response) => response.status), [201, 200]);
  assert.deepEqual(await responses[1].json(), { number: 37, commentId: "1000", duplicate: true });
  const replay = await handler(write(), ADDRESS);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { number: 37, commentId: "1000", duplicate: true });
  assert.equal(posts(calls).length, 1);
});

test("supplement gates missing, PR, unlabeled, closed, locked and 100-comment issues before reading comments", async () => {
  const cases = [[{ state: "closed" }, 409, "closed"], [{ locked: true }, 409, "closed"],
    [{ comments: 100 }, 409, "closed"], [{ comments: 101 }, 409, "closed"],
    [{ pull_request: {} }, 403, "denied"], [{ labels: [] }, 403, "denied"]];
  for (const [overrides, status, code] of cases) {
    const { handler, calls } = setup({ issue: () => issue(overrides) });
    await expectError(await handler(write()), status, code);
    assert.equal(calls.length, 1);
  }
  const { handler, calls } = setup({ fetch: () => new Response(null, { status: 404 }) });
  await expectError(await handler(write()), 403, "denied");
  assert.equal(calls.length, 1);
});

test("3/24h counts distinct marked maintainer comments only, and duplicate replay precedes that limit", async () => {
  const marked = [1, 2, 3].map((id) => comment(id, { body: supplementMarker(id === 1 ? REQUEST_ID : String(id)),
    created_at: new Date(NOW - HOUR).toISOString() }));
  const blocked = setup({ comments: marked });
  const response = await blocked.handler(write({ requestId: REQUEST_ID.replace("abc", "abd") }), ADDRESS);
  await expectError(response, 429, "rate_limited");
  assert.equal(response.headers.get("retry-after"), String(23 * 3600));
  assert.equal((await blocked.handler(write(), ADDRESS)).status, 200);
  assert.equal(posts(blocked.calls).length, 0);
  const allowed = setup({ comments: [marked[0], marked[1],
    comment(4, { body: supplementMarker("old"), created_at: new Date(NOW - DAY).toISOString() }),
    comment(5, { body: supplementMarker(), user: { id: BOT } }),
    comment(6, { body: supplementMarker(), user: { id: 999 } }), comment(7)] });
  assert.equal((await allowed.handler(write({ requestId: REQUEST_ID.replace("abc", "abd") }), ADDRESS)).status, 201);
});

test("replies filter by numeric identities and markers, preserve public text and truncate by code point", async () => {
  const { handler } = setup({ comments: [
    comment(1, { body: "x".repeat(3999) + "😀Z", user: { id: OWNER, login: "renamed" } }),
    comment(2, { body: supplementMarker() + "\nprivate supplement" }),
    comment(3, { body: TRIAGE + "\r\nautomated response", user: { id: BOT } }),
    comment(4, { body: "unmarked bot", user: { id: BOT } }),
    comment(5, { body: TRIAGE + "\nforged bot", user: { id: 999, login: "github-actions[bot]" } }),
    comment(6, { body: "fake owner", user: { id: String(OWNER) } }),
    comment(7, { body: "deleted account", user: null }),
    comment(8, { body: "a".repeat(4000) }),
  ] });
  const [item] = await items(handler);
  assert.deepEqual(Object.keys(item), ["number", "status", "state", "locked", "canSupplement", "comments"]);
  assert.equal(item.canSupplement, true);
  assert.deepEqual(item.comments.map(({ id, author, truncated }) => ({ id, author, truncated })), [
    { id: "1", author: "maintainer", truncated: true }, { id: "3", author: "automation", truncated: false },
    { id: "8", author: "maintainer", truncated: false },
  ]);
  assert.equal(item.comments[0].text, "x".repeat(3999) + "😀");
  assert.equal(item.comments[1].text, "automated response");
  assert.equal(item.comments[0].createdAt, new Date(NOW).toISOString());
  assert.deepEqual(Object.keys(item.comments[0]), ["id", "createdAt", "updatedAt", "author", "text", "truncated"]);
});

test("constructor identities override defaults in reply filters and supplement replay checks", async () => {
  const { handler, calls } = setup({ maintainerId: 10, triageBotId: 20, comments: [
    comment(1), comment(2, { user: { id: 10 } }),
    comment(3, { user: { id: 20 }, body: TRIAGE + "\ntriage" }),
    comment(4, { user: { id: 10 }, body: supplementMarker() }),
  ] });
  assert.deepEqual((await items(handler))[0].comments.map((entry) => entry.id), ["2", "3"]);
  assert.equal((await handler(write())).status, 200);
  assert.equal(posts(calls).length, 0);
});

test("replies keep the newest 50 comments oldest first across at most three pages", async () => {
  const { handler, calls } = setup({ fetch: (url, init, normal) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("/comments")) return normal(url, init);
    const page = Number(parsed.searchParams.get("page") || 1);
    const entries = Array.from({ length: 100 }, (_, index) => {
      const id = (page - 1) * 100 + index + 1;
      return comment(id, { created_at: new Date(NOW + id * 1000).toISOString() });
    }).reverse();
    return Response.json(entries, { headers: { Link: `<${API}/37/comments?per_page=100&page=${page + 1}>; rel="next"` } });
  } });
  const [item] = await items(handler);
  assert.deepEqual(item.comments.map((entry) => entry.id), Array.from({ length: 50 }, (_, index) => String(251 + index)));
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => !call.url.includes("page=4")));
});

test("foreign, wrong-path and credentialed next links fail the item and never receive a token", async () => {
  for (const next of ["https://evil.invalid/comments?page=2", "https://api.github.com.evil.invalid/comments?page=2",
    `http://api.github.com/repos/${REPO}/issues/37/comments?page=2`, `${API}/38/comments?page=2`,
    `${API}/37/comments/extra?page=2`, `https://api.github.com:444/repos/${REPO}/issues/37/comments?page=2`,
    `https://user@api.github.com/repos/${REPO}/issues/37/comments?page=2`, `${API}/37/comments?page=2#fragment`,
    "/relative/comments?page=2"]) {
    const { handler, calls, logs } = setup({ fetch: (url, init, normal) => url.includes("/comments")
      ? Response.json([], { headers: { Link: `<${next}>; rel="next"` } }) : normal(url, init) });
    assert.deepEqual(await items(handler), [{ number: 37, status: "error" }]);
    assert.equal(calls.length, 2);
    await expectError(await handler(write()), 502, "unavailable");
    assert.equal(calls.length, 4);
    assert.equal(posts(calls).length, 0);
    assert.deepEqual(logs.map(([line]) => line), [
      "relay_error stage=replies_comments status=200 kind=redirect",
      "relay_error stage=supplement_comments status=200 kind=redirect",
    ]);
  }
});

test("batch order, per-item failures, unavailable issues and canSupplement states are independent", async () => {
  const { handler, calls } = setup({ fetch: (url, init, normal) => {
    const number = Number(new URL(url).pathname.match(/\/issues\/(\d+)/)?.[1]);
    if (url.includes("/comments")) return number === 6 ? Response.json({ malformed: true }) : normal(url, init);
    if (number === 1) return new Response(null, { status: 404 });
    if (number === 2) return Response.json(issue({ pull_request: {} }));
    if (number === 3) return Response.json(issue({ labels: [] }));
    if (number === 4) return new Response(null, { status: 500 });
    if (number === 7) return Response.json(issue({ state: "closed" }));
    if (number === 8) return Response.json(issue({ locked: true }));
    if (number === 9) return Response.json(issue({ comments: 100 }));
    if (number === 10) return Response.json(issue({ body: "legacy" }));
    return normal(url, init);
  } });
  const result = await items(handler, [3, 1, 2, 6, 4, 5, 7, 8, 9, 10]);
  assert.deepEqual(result.map(({ number, status }) => [number, status]), [
    [3, "unavailable"], [1, "unavailable"], [2, "unavailable"], [6, "error"], [4, "error"], [5, "ok"],
    [7, "ok"], [8, "ok"], [9, "ok"], [10, "ok"],
  ]);
  assert.deepEqual(result.slice(5).map((entry) => entry.canSupplement), [true, false, false, false, false]);
  assert.equal(result[6].state, "closed");
  assert.equal(result[7].locked, true);
  assert.ok(!calls.some((call) => /\/issues\/[123]\/comments/.test(call.url)));
});

test("replies require exact fields and 1-10 distinct positive safe integers before any network work", async () => {
  const { handler, calls } = setup();
  for (const numbers of [[], Array.from({ length: 11 }, (_, i) => i + 1), [1, 1], [0], [-1], [1.1],
    [Number.MAX_SAFE_INTEGER + 1], ["1"], [null], null, {}, 1]) {
    await expectError(await handler(request("/replies", { schema: 1, numbers })), 400, "invalid");
  }
  for (const payload of [{ schema: 2, numbers: [1] }, { schema: 1 }, { schema: 1, numbers: [1], extra: true }, null, []]) {
    await expectError(await handler(request("/replies", payload)), 400, "invalid");
  }
  for (const route of ["/replies", "/supplement"]) {
    for (const method of ["GET", "PUT", "HEAD", "OPTIONS"]) {
      const response = await handler(new Request("https://relay.invalid/feedback" + route, { method }));
      assert.equal(response.headers.get("allow"), "POST");
      await expectError(response, 405, "invalid");
    }
  }
  assert.equal(calls.length, 0);
});

test("reply and supplement byte limits cover both headers and actual UTF-8 bytes", async () => {
  for (const [route, payload, limit] of [["/replies", { schema: 1, numbers: [37] }, 2048], ["/supplement", supplement(), 32768]]) {
    const { handler, calls } = setup();
    const raw = JSON.stringify(payload);
    const exact = raw + " ".repeat(limit - Buffer.byteLength(raw));
    const rawRequest = (body, headers = {}) => new Request("https://relay.invalid/feedback" + route, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
    });
    await expectError(await handler(rawRequest("{}", { "Content-Length": String(limit + 1) })), 413, "too_large");
    await expectError(await handler(rawRequest(exact + " ", { "Content-Length": "1" })), 413, "too_large");
    assert.equal(calls.length, 0);
    assert.equal((await handler(rawRequest(exact), ADDRESS)).status, route === "/replies" ? 200 : 201);
  }
});

test("cache TTL is ten minutes; refresh conditionally revalidates issue and every comment page", async () => {
  let at = NOW;
  let changed = false;
  const { handler, calls } = setup({ now: () => at, fetch: (url, init) => {
    const isComments = url.includes("/comments");
    const page2 = url.includes("page=2");
    const etag = isComments ? page2 ? '"page2"' : '"page1"' : '"issue"';
    if (init.headers["If-None-Match"]) {
      assert.equal(init.headers["If-None-Match"], etag);
      if (changed && page2) return Response.json([comment(2, { body: "edited reply" })], { headers: { ETag: '"edited"' } });
      return new Response(null, { status: 304 });
    }
    return Response.json(isComments ? [comment(page2 ? 2 : 1)] : issue(), {
      headers: { ETag: etag, ...(isComments && !page2 ? { Link: `<${API}/37/comments?page=2>; rel="next"` } : {}) },
    });
  } });
  const first = await items(handler);
  assert.equal(calls.length, 3);
  at += 10 * 60000 - 1;
  assert.deepEqual(await items(handler), first);
  assert.equal(calls.length, 3);
  at++;
  assert.deepEqual(await items(handler), first);
  assert.equal(calls.length, 6);
  at += 10 * 60000;
  changed = true;
  assert.equal((await items(handler))[0].comments[1].text, "edited reply");
  assert.equal(calls.length, 9);
});

test("failed cache refresh returns errors without extending TTL or losing prior ETags", async () => {
  let at = NOW;
  let failing = false;
  const { handler, calls } = setup({ now: () => at, fetch: (url, init, normal) => {
    if (failing && url.includes("/comments")) return new Response(null, { status: 500 });
    if (init.headers["If-None-Match"]) return new Response(null, { status: 304 });
    const response = normal(url, init);
    response.headers.set("etag", '"v1"');
    return response;
  } });
  const first = await items(handler);
  at += 10 * 60000;
  failing = true;
  assert.deepEqual(await items(handler), [{ number: 37, status: "error" }]);
  failing = false;
  assert.deepEqual(await items(handler), first);
  assert.equal(calls.length, 6);
  assert.ok(calls.slice(2).every((call) => call.headers["If-None-Match"] === '"v1"'));
});

test("reply cache evicts the oldest of 500 entries; cache hits do not reorder entries", async () => {
  const { handler, calls } = setup();
  for (let start = 1; start <= 500; start += 10) {
    await items(handler, Array.from({ length: 10 }, (_, i) => start + i), "address-" + start);
  }
  assert.equal(calls.length, 1000);
  await items(handler, [1]);
  assert.equal(calls.length, 1000);
  await items(handler, [501]);
  await items(handler, [2]);
  assert.equal(calls.length, 1002);
  await items(handler, [1]);
  assert.equal(calls.length, 1004);
});

test("30 reads per sliding hour counts cache hits and errors, with hashed trusted addresses", async () => {
  let at = NOW;
  const { handler, calls } = setup({ now: () => at });
  for (let i = 0; i < 30; i++) {
    await items(handler, [37], i % 2 ? ADDRESS : { remoteAddr: { hostname: ADDRESS } });
    if (i === 14) at += HOUR / 2;
  }
  const before = calls.length;
  const blocked = await handler(read(), ADDRESS);
  await expectError(blocked, 429, "rate_limited");
  assert.equal(blocked.headers.get("retry-after"), "1800");
  assert.equal(calls.length, before);
  await items(handler, [37], "another-address");
  at = NOW + HOUR;
  for (let i = 0; i < 15; i++) await items(handler);
  await expectError(await handler(read(), ADDRESS), 429, "rate_limited");
  const failed = setup({ fetch: () => new Response(null, { status: 500 }) });
  for (let i = 0; i < 30; i++) {
    const input = read();
    input.headers.set("x-forwarded-for", "fake-" + i);
    assert.equal((await failed.handler(input, [undefined, {}, "", null][i % 4])).status, 200);
  }
  await expectError(await failed.handler(read()), 429, "rate_limited");
  assert.equal(failed.calls.length, 30);
});

test("reply budget counts every comment page and stops a batch while preserving cache hits", async () => {
  const { handler, calls } = setup({ replyReadBudget: 5, fetch: (url, init, normal) => {
    const parsed = new URL(url);
    if (parsed.pathname !== `/repos/${REPO}/issues/37/comments`) return normal(url, init);
    const page = Number(parsed.searchParams.get("page") || 1);
    return Response.json([comment(page)], { headers: page < 3
      ? { Link: `<${API}/37/comments?per_page=100&page=${page + 1}>; rel="next"` } : {} });
  } });
  assert.equal((await items(handler))[0].status, "ok");
  assert.equal(calls.length, 4);
  const batch = await items(handler, [38, 37, 39], "another-address");
  assert.deepEqual(batch.map(({ number, status }) => [number, status]), [[38, "error"], [37, "ok"], [39, "error"]]);
  assert.equal(calls.length, 5);
  assert.equal(calls.at(-1).url, API + "/38");
});

test("issue and comment revalidation 304s both consume the reply read budget", async () => {
  let refreshAt = NOW;
  const refreshed = setup({ now: () => refreshAt, replyReadBudget: 4, fetch: (url, init, normal) => {
    if (!init.headers["If-None-Match"]) {
      const response = normal(url, init);
      response.headers.set("etag", '"v1"');
      return response;
    }
    return new Response(null, { status: 304 });
  } });
  const first = await items(refreshed.handler);
  refreshAt += 10 * 60000;
  assert.deepEqual(await items(refreshed.handler), first);
  assert.equal(refreshed.calls.length, 4);
  assert.ok(refreshed.calls.slice(2).every((call) => call.headers["If-None-Match"] === '"v1"'));
  assert.equal((await items(refreshed.handler, [38]))[0].status, "error");
  assert.equal(refreshed.calls.length, 4);
});

test("reply budget defaults to exactly 1200 upstream calls across addresses", async () => {
  const { handler, calls } = setup();
  for (let start = 1; start <= 600; start += 10) {
    const batch = await items(handler, Array.from({ length: 10 }, (_, i) => start + i), "client-" + start);
    assert.ok(batch.every((item) => item.status === "ok"));
  }
  assert.equal(calls.length, 1200);
  assert.deepEqual(await items(handler, [601]), [{ number: 601, status: "error" }]);
  assert.equal((await items(handler, [600]))[0].status, "ok");
  assert.equal(calls.length, 1200);
});

test("failed reply calls retain budget reservations and recover one slot at each sliding expiry", async () => {
  let at = NOW;
  const { handler, calls } = setup({ replyReadBudget: 2, now: () => at, fetch: () => { throw new Error(TOKEN); } });
  await items(handler);
  at += HOUR / 2;
  await items(handler, [38], "other-address");
  assert.equal(calls.length, 2);
  at = NOW + HOUR - 1;
  await items(handler, [39]);
  assert.equal(calls.length, 2);
  at++;
  await items(handler, [39, 40]);
  assert.equal(calls.length, 3);
  at = NOW + HOUR + HOUR / 2;
  await items(handler, [41, 42]);
  assert.equal(calls.length, 4);
});

test("concurrent reply requests reserve budget before fetch and a zero budget permits no calls", async () => {
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const releases = [];
  const { handler, calls } = setup({ replyReadBudget: 2, fetch: () => new Promise((resolve) => {
    releases.push(resolve);
    if (releases.length === 2) ready();
  }) });
  const pending = [items(handler, [1]), items(handler, [2], "other-address")];
  await started;
  assert.deepEqual(await items(handler, [3]), [{ number: 3, status: "error" }]);
  assert.equal(calls.length, 2);
  for (const release of releases) release(new Response(null, { status: 500 }));
  assert.ok((await Promise.all(pending)).every(([item]) => item.status === "error"));
  assert.deepEqual(await items(handler, [4]), [{ number: 4, status: "error" }]);
  assert.equal(calls.length, 2);
  const zero = setup({ replyReadBudget: 0 });
  assert.deepEqual(await items(zero.handler), [{ number: 37, status: "error" }]);
  assert.equal(zero.calls.length, 0);
  assert.equal((await zero.handler(request("", creation()), ADDRESS)).status, 201);
  assert.equal((await zero.handler(write(), ADDRESS)).status, 201);
});

test("low numeric rate-limit watermarks block uncached replies but preserve cache hits and expire at reset", async () => {
  let low = false;
  let at = NOW;
  const reset = (NOW + 120000) / 1000;
  const { handler, calls } = setup({ now: () => at, fetch: (url, init, normal) => {
    const response = normal(url, init);
    if (low) {
      response.headers.set("x-ratelimit-remaining", "999");
      response.headers.set("x-ratelimit-reset", String(reset));
    }
    return response;
  } });
  assert.equal((await items(handler))[0].status, "ok");
  low = true;
  assert.equal((await handler(request("", creation()), ADDRESS)).status, 201);
  assert.equal((await handler(write({ number: 40 }), ADDRESS)).status, 201);
  const before = calls.length;
  assert.equal((await items(handler))[0].status, "ok");
  assert.equal((await items(handler, [38]))[0].status, "error");
  assert.equal(calls.length, before);
  at = reset * 1000 - 1;
  assert.equal((await items(handler, [38]))[0].status, "error");
  assert.equal(calls.length, before);
  at++;
  assert.equal((await items(handler, [38]))[0].status, "ok");
  assert.equal(calls.length, before + 2);
});

test("watermark uses the latest numeric header, ignores malformed headers, and clears at 1000 remaining", async () => {
  let headers = { "X-RateLimit-Remaining": "999", "X-RateLimit-Reset": String((NOW + HOUR) / 1000) };
  const { handler, calls } = setup({ fetch: (url, init, normal) => {
    const response = normal(url, init);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  } });
  await expectError(await handler(write({ replyKey: WRONG_KEY }), ADDRESS), 403, "denied");
  for (const value of [undefined, "", "not-numeric", "999garbage", "-1", "1.5", "Infinity", "9007199254740992"]) {
    headers = value === undefined ? {} : { "X-RateLimit-Remaining": value };
    await expectError(await handler(write({ replyKey: WRONG_KEY }), ADDRESS), 403, "denied");
    const before = calls.length;
    assert.deepEqual(await items(handler, [38]), [{ number: 38, status: "error" }]);
    assert.equal(calls.length, before);
  }
  headers = { "X-RateLimit-Remaining": "1000", "X-RateLimit-Reset": String((NOW + HOUR) / 1000) };
  await expectError(await handler(write({ replyKey: WRONG_KEY }), ADDRESS), 403, "denied");
  assert.equal((await items(handler, [38]))[0].status, "ok");
});

test("every API response stage can update the watermark, including failures and revalidation 304s", async (t) => {
  for (const stage of ["replies_issue", "replies_comments", "search_hour", "search_day", "create",
    "supplement_issue", "supplement_comments", "supplement_create", "failure", "304"]) {
    await t.test(stage, async () => {
      let at = NOW;
      let searches = 0;
      const { handler, calls } = setup({ now: () => at, fetch: (url, init, normal) => {
        const actual = url.includes("/search/issues") ? (searches++ % 2 ? "search_day" : "search_hour")
          : url === API ? "create" : url.includes("/comments")
            ? (init.method === "POST" ? "supplement_create" : stage.startsWith("replies_") ? "replies_comments" : "supplement_comments")
            : stage.startsWith("replies_") ? "replies_issue" : "supplement_issue";
        const response = stage === "failure" ? new Response(null, { status: 500 })
          : stage === "304" && init.headers["If-None-Match"] ? new Response(null, { status: 304 }) : normal(url, init);
        if (actual === stage || stage === "failure" || (stage === "304" && response.status === 304)) {
          response.headers.set("X-RateLimit-Remaining", "999");
          response.headers.set("X-RateLimit-Reset", String((NOW + HOUR) / 1000));
        }
        if (stage === "304") response.headers.set("etag", '"v1"');
        return response;
      } });
      if (stage.startsWith("replies_") || stage === "304") {
        await items(handler);
        if (stage === "304") { at += 10 * 60000; await items(handler); }
      } else if (stage.startsWith("search_") || stage === "create") {
        assert.equal((await handler(request("", creation()), ADDRESS)).status, 201);
      } else if (stage === "failure") await expectError(await handler(write(), ADDRESS), 502, "unavailable");
      else assert.equal((await handler(write(), ADDRESS)).status, 201);
      const before = calls.length;
      assert.deepEqual(await items(handler, [38]), [{ number: 38, status: "error" }]);
      assert.equal(calls.length, before);
    });
  }
});

test("a low watermark without a valid reset remains active until a numeric recovery is observed", async () => {
  for (const reset of [undefined, "not-a-timestamp", "9007199254740992"]) {
    const { handler, calls } = setup({ fetch: (url, init, normal) => {
      const response = normal(url, init);
      response.headers.set("X-RateLimit-Remaining", "999");
      if (reset !== undefined) response.headers.set("X-RateLimit-Reset", reset);
      return response;
    } });
    await expectError(await handler(write({ replyKey: WRONG_KEY }), ADDRESS), 403, "denied");
    assert.deepEqual(await items(handler), [{ number: 37, status: "error" }]);
    assert.equal(calls.length, 1);
  }
});

test("supplement attempts are reserved before authentication and failed attempts are retained", async () => {
  let at = NOW;
  const { handler, calls } = setup({ now: () => at });
  for (let attempt = 0; attempt < 30; attempt++) {
    const input = write({ replyKey: WRONG_KEY });
    input.headers.set("X-Forwarded-For", "fake-" + attempt);
    await expectError(await handler(input, attempt % 2 ? ADDRESS : { remoteAddr: { hostname: ADDRESS } }), 403, "denied");
    if (attempt === 14) at += HOUR / 2;
  }
  const blocked = await handler(write(), ADDRESS);
  await expectError(blocked, 429, "rate_limited");
  assert.equal(blocked.headers.get("retry-after"), "1800");
  assert.equal(calls.length, 30);
  at = NOW + HOUR - 1;
  const almost = await handler(write(), ADDRESS);
  await expectError(almost, 429, "rate_limited");
  assert.equal(almost.headers.get("retry-after"), "1");
  at++;
  for (let attempt = 0; attempt < 15; attempt++) {
    await expectError(await handler(write({ replyKey: WRONG_KEY }), ADDRESS), 403, "denied");
  }
  const stillFull = await handler(write(), ADDRESS);
  await expectError(stillFull, 429, "rate_limited");
  assert.equal(stillFull.headers.get("retry-after"), "1800");
  assert.equal(calls.length, 45);
  assert.equal((await handler(write(), "other-address")).status, 201);
});

test("network failures, definite write failures and duplicates never release supplement attempts", async () => {
  for (const outcome of ["network", "http", "duplicate"]) {
    const { handler, calls } = setup({
      comments: outcome === "duplicate" ? [comment(1, { body: supplementMarker() })] : [],
      fetch: (url, init, normal) => {
        if (outcome === "network") throw new Error(TOKEN);
        return outcome === "http" && init.method === "POST" ? new Response(null, { status: 422 }) : normal(url, init);
      },
    });
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await handler(write(), ADDRESS);
      if (outcome === "duplicate") assert.equal(response.status, 200);
      else await expectError(response, 502, "unavailable");
    }
    const before = calls.length;
    await expectError(await handler(write(), ADDRESS), 429, "rate_limited");
    assert.equal(calls.length, before);
    assert.equal(posts(calls).length, outcome === "http" ? 30 : 0);
  }
});

test("concurrent supplements reserve attempts before queuing on the same issue", async () => {
  let release;
  let blocked;
  let first = true;
  const rejected = new Promise((resolve) => { blocked = resolve; });
  const { handler, calls } = setup({ fetch: (url, init, normal) => {
    if (!first) return normal(url, init);
    first = false;
    return new Promise((resolve) => { release = resolve; });
  } });
  const pending = Array.from({ length: 31 }, () => handler(write({ replyKey: WRONG_KEY }), ADDRESS).then((response) => {
    if (response.status === 429) blocked(response);
    return response;
  }));
  await expectError(await rejected, 429, "rate_limited");
  assert.equal(calls.length, 1);
  release(Response.json(issue()));
  const responses = await Promise.all(pending);
  assert.equal(responses.filter((response) => response.status === 403).length, 30);
  assert.equal(calls.length, 30);
});

test("an open breaker returns replies 503 before reserving the per-address read quota", async () => {
  let at = NOW;
  let failing = true;
  const { handler, calls } = setup({ now: () => at, fetch: (url, init, normal) => {
    if (failing) return new Response("rate limited", { status: 403, headers: { "Retry-After": "120" } });
    return normal(url, init);
  } });
  assert.deepEqual(await items(handler), [{ number: 37, status: "error" }]);
  assert.equal(calls.length, 1);
  const blocked = await handler(read(), ADDRESS);
  await expectError(blocked, 503, "unavailable");
  assert.equal(blocked.headers.get("retry-after"), "120");
  assert.equal(calls.length, 1);
  at += 120000;
  failing = false;
  for (let i = 0; i < 29; i++) assert.equal((await handler(read(), ADDRESS)).status, 200);
  await expectError(await handler(read(), ADDRESS), 429, "rate_limited");
});

test("public reads work without a token and when disabled; supplements require enabled writes", async () => {
  for (const options of [{ token: undefined }, { token: " \r\n " }, { disabled: true }]) {
    const { handler, calls } = setup(options);
    assert.equal((await items(handler))[0].status, "ok");
    if (!options.disabled) assert.ok(calls.every((call) => !new Headers(call.headers).has("authorization")));
    const count = calls.length;
    await expectError(await handler(write()), 503, "disabled");
    assert.equal(calls.length, count);
  }
});

test("supplement quotas allow 10/address/day and 20 globally/hour, with sliding recovery", async () => {
  let at = NOW;
  const { handler, calls } = setup({ now: () => at });
  for (let number = 1; number <= 10; number++) assert.equal((await handler(write({ number }), ADDRESS)).status, 201);
  const blocked = await handler(write({ number: 11 }), ADDRESS);
  await expectError(blocked, 429, "rate_limited");
  assert.equal(blocked.headers.get("retry-after"), "86400");
  for (let number = 11; number <= 20; number++) assert.equal((await handler(write({ number }), "other")).status, 201);
  const global = await handler(write({ number: 21 }), "third");
  await expectError(global, 429, "rate_limited");
  assert.equal(global.headers.get("retry-after"), "3600");
  assert.equal(posts(calls).length, 20);
  // A replay remains valid even when both quotas are exhausted.
  assert.equal((await handler(write({ number: 1 }), ADDRESS)).status, 200);
  at += HOUR;
  for (let number = 21; number <= 30; number++) assert.equal((await handler(write({ number }), "third")).status, 201);
  await expectError(await handler(write({ number: 31 }), ADDRESS), 429, "rate_limited");
  at = NOW + DAY;
  assert.equal((await handler(write({ number: 31 }), ADDRESS)).status, 201);
});

test("supplement reservations release on definite HTTP failure but retain uncertain network outcomes", async () => {
  for (const uncertain of [false, true]) {
    const { handler, calls } = setup({ fetch: (url, init, normal) => {
      if (init.method !== "POST") return normal(url, init);
      if (uncertain) throw new Error(KEY + TOKEN + ADDRESS);
      return new Response(null, { status: 422 });
    } });
    for (let number = 1; number <= 10; number++) await expectError(await handler(write({ number }), ADDRESS), 502, "unavailable");
    await expectError(await handler(write({ number: 11 }), ADDRESS), uncertain ? 429 : 502, uncertain ? "rate_limited" : "unavailable");
    assert.equal(posts(calls).length, uncertain ? 10 : 11);
  }
});

test("concurrent supplements reserve global quota before POST and definite failures free all slots", async () => {
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const releases = [];
  let stalled = true;
  const { handler, calls } = setup({ fetch: (url, init, normal) => {
    if (!stalled || init.method !== "POST") return normal(url, init);
    return new Promise((resolve) => {
      releases.push(resolve);
      if (releases.length === 20) ready();
    });
  } });
  const pending = Array.from({ length: 20 }, (_, i) => handler(write({ number: i + 1 }), "client-" + i));
  await started;
  await expectError(await handler(write({ number: 21 }), "new-client"), 429, "rate_limited");
  assert.equal(posts(calls).length, 20);
  for (const release of releases) release(new Response(null, { status: 422 }));
  assert.ok((await Promise.all(pending)).every((response) => response.status === 502));
  stalled = false;
  assert.equal((await handler(write({ number: 21 }), "new-client")).status, 201);
});

test("403 Retry-After opens a shared breaker for reads and writes, including cached reads, until expiry", async () => {
  let at = NOW;
  let failing = false;
  const { handler, calls, logs } = setup({ now: () => at, fetch: (url, init, normal) => {
    if (url.startsWith("https://github.com/")) {
      const response = new Response("{}");
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    if (failing) return new Response(KEY, { status: 403, headers: { "Retry-After": "120" } });
    return normal(url, init);
  } });
  await items(handler);
  failing = true;
  assert.deepEqual(await items(handler, [38]), [{ number: 38, status: "error" }]);
  const before = calls.length;
  const blocked = await handler(read());
  await expectError(blocked, 503, "unavailable");
  assert.equal(blocked.headers.get("retry-after"), "120");
  for (const input of [write(), request("", creation())]) {
    const response = await handler(input, ADDRESS);
    await expectError(response, 503, "unavailable");
    assert.equal(response.headers.get("retry-after"), "120");
  }
  assert.equal(calls.length, before);
  const pack = await handler(new Request("https://relay.invalid/device-pack/v1/device-pack-v1-latest.json"), ADDRESS);
  assert.equal(pack.status, 200);
  assert.equal(calls.length, before + 1);
  failing = false;
  at += 119999;
  const almost = await handler(write(), ADDRESS);
  await expectError(almost, 503, "unavailable");
  assert.equal(almost.headers.get("retry-after"), "1");
  at++;
  assert.equal((await handler(write(), ADDRESS)).status, 201);
  assert.equal((await items(handler))[0].status, "ok");
  assert.ok(logs.every(([line]) => /^relay_error stage=\w+ status=\d+ kind=\w+$/.test(line)));
  assert.ok(!JSON.stringify(logs).includes(KEY));
});

test("breaker handles 429, HTTP-date Retry-After and rate-reset, caps one hour, and ignores ordinary 403", async () => {
  for (const [status, headers, seconds] of [
    [429, { "Retry-After": "999999" }, 3600],
    [403, { "Retry-After": new Date(NOW + 90000).toUTCString() }, 90],
    [403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String((NOW + 60000) / 1000) }, 60],
    [429, { "X-RateLimit-Remaining": "0" }, 3600],
    [403, { "Retry-After": "0" }, 0],
    [403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String((NOW - 1000) / 1000) }, 0],
    [403, {}, null],
  ]) {
    let at = NOW;
    let failing = true;
    const { handler, calls } = setup({ now: () => at, fetch: (url, init, normal) => failing
      ? new Response(null, { status, headers }) : normal(url, init) });
    const response = await handler(write(), ADDRESS);
    await expectError(response, seconds ? 503 : 502, "unavailable");
    assert.equal(response.headers.get("retry-after"), seconds ? String(seconds) : null);
    failing = false;
    if (seconds) {
      const blocked = await handler(read());
      await expectError(blocked, 503, "unavailable");
      assert.equal(blocked.headers.get("retry-after"), String(seconds));
      assert.equal(calls.length, 1);
      at += seconds * 1000;
    }
    assert.equal((await handler(write(), ADDRESS)).status, 201);
  }
});

test("breaker opens from searches and comment creation as well as issue and comment reads", async () => {
  for (const stage of ["search", "create", "comments_read", "comments_write"]) {
    const { handler, calls } = setup({ fetch: (url, init, normal) => {
      const fails = stage === "search" ? url.includes("/search/issues")
        : stage === "create" ? url === API && init.method === "POST"
          : url.includes("/comments") && init.method === (stage === "comments_read" ? "GET" : "POST");
      return fails ? new Response(null, { status: 403, headers: { "Retry-After": "60" } }) : normal(url, init);
    } });
    const response = await handler(stage === "search" || stage === "create" ? request("", creation()) : write(), ADDRESS);
    await expectError(response, 503, "unavailable");
    const count = calls.length;
    const blocked = await handler(read());
    await expectError(blocked, 503, "unavailable");
    assert.equal(blocked.headers.get("retry-after"), "60");
    await expectError(await handler(write()), 503, "unavailable");
    assert.equal(calls.length, count);
  }
});

test("authenticated redirects are never followed and new failure stages log only safe metadata", async () => {
  for (const [route, stage] of [["/replies", "replies_issue"], ["/supplement", "supplement_issue"], ["", "search_hour"]]) {
    const { handler, calls, logs } = setup({ fetch: () => new Response(KEY + ADDRESS, {
      status: 302, headers: { Location: "https://evil.invalid/?secret=" + TOKEN },
    }) });
    const response = await handler(route === "/replies" ? read() : route === "/supplement" ? write() : request("", creation()));
    assert.equal(response.status, route === "/replies" ? 200 : 502);
    assert.ok(calls.every((call) => call.redirect === "manual" && new URL(call.url).host === "api.github.com"));
    assert.deepEqual(logs, [[`relay_error stage=${stage} status=302 kind=redirect`]]);
    assert.ok(!JSON.stringify(logs).includes(TOKEN));
  }
});

test("malformed trusted comments and malformed created IDs fail closed without logging upstream data", async () => {
  for (const overrides of [{ id: "123\n" }, { created_at: KEY }, { updated_at: null }]) {
    const { handler, logs } = setup({ comments: [comment(1, overrides)] });
    assert.deepEqual(await items(handler), [{ number: 37, status: "error" }]);
    assert.deepEqual(logs, [["relay_error stage=replies_comments status=200 kind=bad_body"]]);
  }
  const { handler, logs } = setup({ fetch: (url, init, normal) => init.method === "POST"
    ? Response.json({ id: "123\n", privateText: KEY }, { status: 201 }) : normal(url, init) });
  await expectError(await handler(write()), 502, "unavailable");
  assert.deepEqual(logs, [["relay_error stage=supplement_create status=201 kind=bad_body"]]);
});
