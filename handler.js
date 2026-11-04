const DEFAULT_REPO = "wushuai0802/myfinder-device-battery";
const MAX_BODY_BYTES = 32768;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_ADDRESSES = 10000;
const GITHUB_TIMEOUT = 10000;
const MINUTE = 60 * 1000;
const DEVICE_PACK_PREFIX = "/device-pack/v1/";
const DEVICE_PACK_UPSTREAM = "https://github.com/wushuai0802/myfinder-device-battery/releases/download/device-pack/";
const DEVICE_PACK_HOSTS = new Set([
  "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
]);
const DEVICE_PACK_NAME = /^device-pack-v1-(latest|[1-9][0-9]{0,9})\.json(\.sig)?$/;
const MAX_DEVICE_PACK_FILES = 64;
const CATEGORIES = Object.freeze({
  device: "设备不识别",
  battery: "电量或 DPI 不对",
  ui: "界面或操作",
  other: "其他",
});
const FIELDS = ["schema", "category", "description", "diagnostics", "appVersion"];
const SUPPLEMENT_FIELDS = ["schema", "number", "replyKey", "requestId", "description", "diagnostics", "appVersion"];
const SUPPLEMENT_PREFIX = "<!-- myfinder-supplement:v1 ";
const TRIAGE_MARKER = "<!-- myfinder-triage:v1 -->";
const REPLY_NOTICE = "<!-- 程序内反馈凭证摘要，请勿删除下一行 -->";
const REPLY_TTL = 10 * MINUTE;

class RelayError extends Error {
  constructor(stage, status, kind) {
    super();
    this.stage = stage;
    this.status = status;
    this.kind = kind;
  }
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function error(status, code, headers) {
  return json(status, { error: code }, headers);
}

function limited(seconds) {
  return error(429, "rate_limited", { "Retry-After": String(seconds) });
}

function cleanText(text) {
  return text.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function characters(text) {
  return Array.from(text);
}

async function readPayload(request, route = "/feedback") {
  const limit = route === "/feedback/replies" ? 2048 : MAX_BODY_BYTES;
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) return { failure: error(400, "invalid") };
    if (Number(length) > limit) return { failure: error(413, "too_large") };
  }
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json" || !request.body) {
    return { failure: error(400, "invalid") };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let payload;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        // Do not wait for an untrusted stream's cancellation callback.
        void reader.cancel().catch(() => {});
        return { failure: error(413, "too_large") };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { failure: error(400, "invalid") };
  } finally {
    reader.releaseLock();
  }

  const supplement = route === "/feedback/supplement";
  const replies = route === "/feedback/replies";
  const fields = replies ? ["schema", "numbers"] : supplement ? SUPPLEMENT_FIELDS
    : payload?.schema === 2 ? [...FIELDS, "replyKey"] : FIELDS;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).length !== fields.length
      || !fields.every((field) => Object.hasOwn(payload, field))) {
    return { failure: error(400, "invalid") };
  }
  if (replies) {
    if (payload.schema !== 1 || !Array.isArray(payload.numbers)
        || payload.numbers.length < 1 || payload.numbers.length > 10
        || !payload.numbers.every(positiveInteger)
        || new Set(payload.numbers).size !== payload.numbers.length) {
      return { failure: error(400, "invalid") };
    }
    return { payload };
  }
  if ((supplement ? payload.schema !== 1 : ![1, 2].includes(payload.schema))
      || (!supplement && (typeof payload.category !== "string" || !Object.hasOwn(CATEGORIES, payload.category)))
      || ((supplement || payload.schema === 2) && !validReplyKey(payload.replyKey))
      || (supplement && (!positiveInteger(payload.number) || typeof payload.requestId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.requestId)
        || payload.requestId.length !== 36))
      || typeof payload.description !== "string"
      || (payload.diagnostics !== null && typeof payload.diagnostics !== "string")
      || typeof payload.appVersion !== "string") {
    return { failure: error(400, "invalid") };
  }

  const description = payload.description.trim();
  const descriptionLength = characters(description).length;
  if (descriptionLength < 5 || descriptionLength > 2000
      || (payload.diagnostics !== null && characters(payload.diagnostics).length > 20000)
      || payload.appVersion.length > 32
      || /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.exec(payload.appVersion)?.[0] !== payload.appVersion) {
    return { failure: error(400, "invalid") };
  }
  return {
    payload: {
      ...payload,
      description: cleanText(description),
      diagnostics: payload.diagnostics === null ? null : cleanText(payload.diagnostics),
    },
  };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validReplyKey(value) {
  if (typeof value !== "string" || value.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=").length === 32;
}

async function replyHash(key) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode("myfinder/reply/v1\0" + key),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function replyMarker(body) {
  if (typeof body !== "string") return null;
  const lastLine = body.trimEnd().split("\n").at(-1);
  return /^<!-- myfinder-reply:v1 sha256=([0-9a-f]{64}) -->$/.exec(lastLine)?.[1] ?? null;
}

async function equalHash(left, right) {
  // Delegate constant-time tag comparison to Web Crypto, not a JS string comparison.
  // This fixed public HMAC key is only a comparison aid, not a stored secret.
  const crypto = globalThis.crypto.subtle;
  const key = await crypto.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const encoder = new TextEncoder();
  const signature = await crypto.sign("HMAC", key, encoder.encode(left));
  return crypto.verify("HMAC", key, signature, encoder.encode(right));
}

function supplementContent(payload) {
  let body = `${SUPPLEMENT_PREFIX}request=${payload.requestId} -->\n来自程序内补充 · 版本 ${payload.appVersion}\n\n**描述**\n${codeBlock(payload.description)}`;
  if (payload.diagnostics !== null) {
    body += `\n\n<details><summary>诊断信息</summary>\n\n${codeBlock(payload.diagnostics)}\n\n</details>`;
  }
  return { body };
}

// Timestamp reservations are retained for successful or uncertain writes, and removable
// for definite failures. Maps are keyed only by address hashes (or a fixed global key).
function slidingQuota(limit, window) {
  const entries = new Map();
  return (key, at) => {
    for (const [storedKey, events] of entries) {
      while (events.length && events[0].at <= at - window) events.shift();
      if (!events.length) entries.delete(storedKey);
    }
    let events = entries.get(key);
    if (!events) {
      if (entries.size >= MAX_ADDRESSES) return { retry: Math.ceil(window / 1000) };
      events = [];
      entries.set(key, events);
    }
    if (limit <= 0) return { retry: Math.ceil(window / 1000) };
    if (events.length >= limit) return { retry: Math.max(1, Math.ceil((events[0].at + window - at) / 1000)) };
    const event = { at };
    events.push(event);
    return { release() {
      const index = events.indexOf(event);
      if (index !== -1) events.splice(index, 1);
      if (!events.length && entries.get(key) === events) entries.delete(key);
    } };
  };
}

function codeBlock(text) {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

function issueContent(payload) {
  const category = CATEGORIES[payload.category];
  const firstLine = characters(payload.description.split("\n", 1)[0]).slice(0, 40).join("");
  const title = characters(`[程序内反馈] ${category}：${firstLine}`
    .replace(/[\r\n\u2028\u2029]/g, " ").replace(/@/g, "＠").replace(/#/g, "＃"))
    .slice(0, 120).join("");
  let body = `来自程序内反馈 · 版本 ${payload.appVersion}\n\n**类型**：${category}\n\n**描述**\n${codeBlock(payload.description)}`;
  if (payload.diagnostics) {
    body += `\n\n<details><summary>诊断信息</summary>\n\n${codeBlock(payload.diagnostics)}\n\n</details>`;
  }
  return { title, body, labels: ["in-app-feedback"] };
}

async function hashAddress(info) {
  const address = typeof info === "string" ? info : info?.remoteAddr?.hostname;
  const input = typeof address === "string" && address ? `address:${address}` : "unknown";
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function devicePackResponse(response, method) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

function matchesETag(condition, etag) {
  if (condition?.trim() === "*") return true;
  if (!condition || !etag) return false;
  // GET/HEAD use weak comparison; quoted tags may themselves contain commas.
  return Array.from(condition.matchAll(/(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/g))
    .some(([tag]) => tag.replace(/^W\//, "") === etag.replace(/^W\//, ""));
}

function createDevicePackMirror(fetchImpl, now) {
  const cache = new Map();
  const addresses = new Map();

  function reserve(key, at) {
    for (const [storedKey, times] of addresses) {
      while (times.length && times[0] <= at - MINUTE) times.shift();
      if (!times.length) addresses.delete(storedKey);
    }
    let times = addresses.get(key);
    if (!times) {
      if (addresses.size >= MAX_ADDRESSES) return 60;
      times = [];
      addresses.set(key, times);
    }
    if (times.length >= 60) return Math.max(1, Math.ceil((times[0] + MINUTE - at) / 1000));
    times.push(at);
    return 0;
  }

  async function download(filename, limit) {
    const controller = new AbortController();
    let timeout;
    let response;
    let reader;
    let status = 0;
    try {
      return await Promise.race([
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            reject(new RelayError("device_pack", status, "timeout"));
            controller.abort();
            if (reader) void reader.cancel().catch(() => {});
          }, GITHUB_TIMEOUT);
        }),
        (async () => {
          try {
            // Never use the authenticated feedback client or any incoming headers.
            response = await fetchImpl(DEVICE_PACK_UPSTREAM + filename, {
              method: "GET", redirect: "follow", credentials: "omit", signal: controller.signal,
            });
          } catch {
            throw new RelayError("device_pack", 0, "network");
          }
          if (controller.signal.aborted) {
            // A fetch implementation can settle after the deadline despite abort.
            if (response.body) void response.body.cancel().catch(() => {});
            throw new RelayError("device_pack", 0, "timeout");
          }
          status = response.status;
          let finalURL;
          try { finalURL = new URL(response.url); } catch { /* Fail closed below. */ }
          if (!finalURL || finalURL.protocol !== "https:" || !DEVICE_PACK_HOSTS.has(finalURL.host)) {
            throw new RelayError("device_pack", status, "redirect");
          }
          if (status === 404) return null;
          if (status !== 200) throw new RelayError("device_pack", status, "http");
          const length = response.headers.get("content-length");
          if (length !== null && Number(length) > limit) {
            throw new RelayError("device_pack", status, "too_large");
          }
          const chunks = [];
          let size = 0;
          try {
            reader = response.body?.getReader();
            while (reader) {
              const { done, value } = await reader.read();
              controller.signal.throwIfAborted();
              if (done) break;
              size += value.byteLength;
              if (size > limit) throw new RelayError("device_pack", status, "too_large");
              chunks.push(value);
            }
          } catch (failure) {
            throw failure instanceof RelayError ? failure : new RelayError("device_pack", status, "bad_body");
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return { bytes, etag: response.headers.get("etag") };
        })(),
      ]);
    } finally {
      clearTimeout(timeout);
      // Never wait for an upstream cancellation callback to finish.
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else if (response?.body) {
        void response.body.cancel().catch(() => {});
      }
    }
  }

  return async (request, info, filename) => {
    const match = DEVICE_PACK_NAME.exec(filename);
    if (!match || match[0] !== filename || (match[1] === "latest" && match[2])) {
      return error(404, "invalid");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return error(405, "invalid", { Allow: "GET, HEAD" });
    }
    const key = await hashAddress(info);
    const at = now();
    const retry = reserve(key, at);
    if (retry) return limited(retry);

    const latest = match[1] === "latest";
    const signature = Boolean(match[2]);
    const ttl = latest ? 5 * MINUTE : DAY;
    for (const [name, entry] of cache) {
      if (entry.expires <= at) cache.delete(name);
    }
    let entry = cache.get(filename);
    if (!entry) {
      const downloaded = await download(filename, latest || signature ? 4096 : 256 * 1024);
      if (!downloaded) return error(404, "invalid");
      entry = { ...downloaded, expires: now() + ttl };
      cache.delete(filename);
      cache.set(filename, entry);
      if (cache.size > MAX_DEVICE_PACK_FILES) cache.delete(cache.keys().next().value);
    }
    const headers = {
      "Content-Type": signature ? "text/plain" : "application/json",
      "Cache-Control": latest ? "public, max-age=300" : "public, max-age=86400, immutable",
      ...(entry.etag === null ? {} : { ETag: entry.etag }),
    };
    if (matchesETag(request.headers.get("if-none-match"), entry.etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === "HEAD" ? null : entry.bytes, { headers });
  };
}

/**
 * Portable Fetch handler. info may be a hostname string or Deno's serve info.
 * Missing addresses share one bucket; forwarded headers are never trusted.
 */
export function createHandler({
  token,
  repo = DEFAULT_REPO,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  disabled = false,
  log = console.error,
  maintainerId = 50058348,
  triageBotId = 41898282,
  replyReadBudget = 1200,
} = {}) {
  if (typeof token === "string") token = token.trim();
  const devicePack = createDevicePackMirror(fetchImpl, now);
  const replyCache = new Map();
  const supplementLocks = new Map();
  const reserveRead = slidingQuota(30, HOUR);
  const reserveReplyUpstream = slidingQuota(replyReadBudget, HOUR);
  const reserveSupplementAttempt = slidingQuota(30, HOUR);
  const reserveSupplementAddress = slidingQuota(10, DAY);
  const reserveSupplementGlobal = slidingQuota(20, HOUR);
  let pausedUntil = 0;
  let latestRateLimit = null;
  // The creation quota stores only address hashes, success timestamps and pending counts.
  const addresses = new Map();

  function reserve(key, at) {
    for (const [storedKey, entry] of addresses) {
      while (entry.successes.length && entry.successes[0] <= at - HOUR) entry.successes.shift();
      if (!entry.pending && !entry.successes.length) addresses.delete(storedKey);
    }
    let entry = addresses.get(key);
    if (!entry) {
      if (addresses.size >= MAX_ADDRESSES) return { retry: 3600 };
      entry = { successes: [], pending: 0 };
      addresses.set(key, entry);
    }
    if (entry.successes.length + entry.pending >= 3) {
      return { retry: entry.successes.length
        ? Math.max(1, Math.ceil((entry.successes[0] + HOUR - at) / 1000)) : 60 };
    }
    entry.pending++;
    return { entry };
  }

  function pauseSeconds() {
    if (!pausedUntil) return 0;
    return Math.max(0, Math.ceil((pausedUntil - now()) / 1000));
  }

  function observeRateLimit(response) {
    const remainingHeader = response.headers?.get("x-ratelimit-remaining");
    if (remainingHeader === null || remainingHeader === undefined) return;
    const remainingText = remainingHeader.trim();
    if (!/^\d+$/.test(remainingText)) return;
    const remaining = Number(remainingText);
    if (!Number.isSafeInteger(remaining)) return;
    const resetHeader = response.headers?.get("x-ratelimit-reset");
    const resetText = resetHeader === null || resetHeader === undefined ? "" : resetHeader.trim();
    let resetAt = null;
    if (/^\d+$/.test(resetText)) {
      const resetSeconds = Number(resetText);
      if (Number.isSafeInteger(resetSeconds) && resetSeconds <= Number.MAX_SAFE_INTEGER / 1000) {
        resetAt = resetSeconds * 1000;
      }
    }
    latestRateLimit = { remaining, resetAt };
  }

  function replyWatermarkActive() {
    return latestRateLimit !== null && latestRateLimit.remaining < 1000
      && (latestRateLimit.resetAt === null || latestRateLimit.resetAt > now());
  }

  function protectUpstream(response) {
    if (![403, 429].includes(response.status)) return;
    const retry = response.headers?.get("retry-after");
    const exhausted = response.headers?.get("x-ratelimit-remaining") === "0";
    if (retry == null && !exhausted) return;
    const at = now();
    const deadlines = [];
    if (retry !== null && retry !== undefined) {
      const deadline = /^\d+(\.\d+)?$/.test(retry) ? at + Number(retry) * 1000 : Date.parse(retry);
      if (Number.isFinite(deadline)) deadlines.push(deadline);
    }
    if (exhausted) {
      const reset = response.headers?.get("x-ratelimit-reset");
      if (reset !== null && /^\d+$/.test(reset)) deadlines.push(Number(reset) * 1000);
    }
    const until = deadlines.length ? Math.max(...deadlines) : at + HOUR;
    pausedUntil = Math.max(pausedUntil, Math.min(at + HOUR, until));
  }

  function logFailure(failure) {
    // Only internally generated metadata is safe; never inspect external errors.
    const { stage, status, kind } = failure instanceof RelayError
      ? failure : { stage: "unexpected", status: 0, kind: "unexpected" };
    try { log(`relay_error stage=${stage} status=${status} kind=${kind}`); } catch { /* Logging is best effort. */ }
  }

  async function githubJson(stage, url, method = "GET", body,
    { cached, allowMissing = false, replyRead = false } = {}) {
    if (pauseSeconds()) throw new RelayError(stage, 0, "paused");
    const target = new URL(url);
    if (target.origin !== "https://api.github.com" || target.username || target.password || target.hash) {
      throw new RelayError(stage, 0, "redirect");
    }
    if (replyRead && replyWatermarkActive()) throw new RelayError(stage, 0, "watermark");
    if (replyRead && reserveReplyUpstream("global", now()).retry) {
      throw new RelayError(stage, 0, "read_budget");
    }
    const controller = new AbortController();
    let timeout;
    let status = 0;
    try {
      return await Promise.race([
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            reject(new RelayError(stage, status, "timeout"));
            controller.abort();
          }, GITHUB_TIMEOUT);
        }),
        (async () => {
          let response;
          try {
            response = await fetchImpl(url, {
              method,
              redirect: "manual",
              credentials: "omit",
              headers: {
                ...(typeof token === "string" && token ? { Authorization: `Bearer ${token}` } : {}),
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "myfinder-feedback-relay",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
              },
              signal: controller.signal,
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
          } catch {
            throw new RelayError(stage, 0, "network");
          }
          status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status : 0;
          observeRateLimit(response);
          if (controller.signal.aborted) {
            if (response.body) void response.body.cancel().catch(() => {});
            throw new RelayError(stage, status, "timeout");
          }
          protectUpstream(response);
          if (status === 304 && cached?.etag) {
            return { ...cached, status, etag: response.headers?.get("etag") ?? cached.etag,
              link: response.headers?.get("link") ?? cached.link };
          }
          if (status === 404 && allowMissing) return { data: null, status };
          if (status >= 300 && status < 400) throw new RelayError(stage, status, "redirect");
          if (!response.ok) throw new RelayError(stage, status, "http");
          try {
            const data = await response.json();
            controller.signal.throwIfAborted();
            return { data, status, etag: response.headers?.get("etag") ?? null,
              link: response.headers?.get("link") ?? null };
          } catch {
            throw new RelayError(stage, status, "bad_body");
          }
        })(),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function searchCount(stage, since) {
    const url = new URL("https://api.github.com/search/issues");
    url.searchParams.set("q", `repo:${repo} is:issue label:in-app-feedback created:>=${new Date(since).toISOString()}`);
    url.searchParams.set("per_page", "1");
    const { data, status } = await githubJson(stage, url.href);
    if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || data.incomplete_results === true) {
      throw new RelayError(stage, status, "bad_body");
    }
    return data.total_count;
  }

  function issueURL(number) {
    return `https://api.github.com/repos/${repo}/issues/${number}`;
  }

  function availableIssue(issue, stage, status) {
    if (issue === null || issue?.pull_request) return false;
    if (!Array.isArray(issue?.labels)) throw new RelayError(stage, status, "bad_body");
    if (!issue.labels.some((label) => (typeof label === "string" ? label : label?.name) === "in-app-feedback")) return false;
    if (!["open", "closed"].includes(issue.state) || typeof issue.locked !== "boolean"
        || !Number.isSafeInteger(issue.comments) || issue.comments < 0
        || (issue.body !== null && typeof issue.body !== "string")) {
      throw new RelayError(stage, status, "bad_body");
    }
    return true;
  }

  function nextComments(link, number, stage, status) {
    if (!link) return null;
    for (const part of link.split(/,(?=\s*<)/)) {
      const match = /^\s*<([^>]+)>(.*)$/.exec(part);
      if (!match) throw new RelayError(stage, status, "bad_body");
      const relation = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(match[2]);
      if (!(relation?.[1] ?? relation?.[2] ?? "").split(/\s+/).includes("next")) continue;
      let next;
      try { next = new URL(match[1]); } catch { throw new RelayError(stage, status, "redirect"); }
      if (next.origin !== "https://api.github.com" || next.username || next.password || next.hash
          || next.pathname !== new URL(issueURL(number) + "/comments").pathname || !next.search) {
        throw new RelayError(stage, status, "redirect");
      }
      return next.href;
    }
    return null;
  }

  async function commentsFor(number, stage, cachedPages = []) {
    let url = issueURL(number) + "/comments?per_page=100";
    const pages = [];
    const seen = new Set();
    while (url && pages.length < 3) {
      if (seen.has(url)) throw new RelayError(stage, 0, "bad_body");
      seen.add(url);
      const cached = cachedPages.find((page) => page.url === url);
      const resource = await githubJson(stage, url, "GET", undefined,
        { cached, replyRead: stage === "replies_comments" });
      if (!Array.isArray(resource.data) || resource.data.length > 100
          || resource.data.some((comment) => !comment || typeof comment !== "object"
            || (comment.body !== null && typeof comment.body !== "string"))) {
        throw new RelayError(stage, resource.status, "bad_body");
      }
      pages.push({ ...resource, url });
      // Validate even the third page's next link, but never fetch a fourth page.
      url = nextComments(resource.link, number, stage, resource.status);
    }
    return { pages, comments: pages.flatMap((page) => page.data) };
  }

  function commentId(comment, stage, status = 200) {
    if (positiveInteger(comment?.id)) return String(comment.id);
    if (typeof comment?.id === "string" && /^[1-9][0-9]*$/.exec(comment.id)?.[0] === comment.id) return comment.id;
    throw new RelayError(stage, status, "bad_body");
  }

  function commentTime(value, stage) {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(parsed)) throw new RelayError(stage, 200, "bad_body");
    return parsed;
  }

  function publicComments(comments) {
    const selected = new Map();
    for (const comment of comments) {
      let text = comment.body;
      if (typeof text !== "string") continue;
      let author;
      if (comment.user?.id === maintainerId && !text.startsWith(SUPPLEMENT_PREFIX)) author = "maintainer";
      else if (comment.user?.id === triageBotId && text.startsWith(TRIAGE_MARKER)) {
        author = "automation";
        text = text.slice(TRIAGE_MARKER.length).replace(/^\r?\n/, "");
      } else continue;
      const id = commentId(comment, "replies_comments");
      commentTime(comment.created_at, "replies_comments");
      commentTime(comment.updated_at, "replies_comments");
      const points = characters(text);
      selected.set(id, { id, createdAt: comment.created_at, updatedAt: comment.updated_at,
        author, text: points.slice(0, 4000).join(""), truncated: points.length > 4000 });
    }
    return [...selected.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
      || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).slice(-50);
  }

  async function repliesFor(number) {
    // A live breaker takes precedence even over a fresh cache entry.
    if (pauseSeconds()) throw new RelayError("replies_issue", 0, "paused");
    const cached = replyCache.get(number);
    if (cached && cached.expires > now()) return cached.item;
    const resource = await githubJson("replies_issue", issueURL(number), "GET", undefined,
      { cached: cached?.resource, allowMissing: true, replyRead: true });
    let item = { number, status: "unavailable" };
    let pages = [];
    const issue = resource.data;
    if (availableIssue(issue, "replies_issue", resource.status)) {
      const result = await commentsFor(number, "replies_comments", cached?.pages);
      pages = result.pages;
      item = { number, status: "ok", state: issue.state, locked: issue.locked,
        canSupplement: issue.state === "open" && !issue.locked && issue.comments < 100 && replyMarker(issue.body) !== null,
        comments: publicComments(result.comments) };
    }
    replyCache.delete(number);
    replyCache.set(number, { resource, pages, item, expires: now() + REPLY_TTL });
    if (replyCache.size > 500) replyCache.delete(replyCache.keys().next().value);
    return item;
  }

  async function replies(payload, info) {
    const key = await hashAddress(info);
    // Another request can open the breaker while address hashing is pending.
    const paused = pauseSeconds();
    if (paused) return error(503, "unavailable", { "Retry-After": String(paused) });
    const reservation = reserveRead(key, now());
    if (reservation.retry) return limited(reservation.retry);
    const items = [];
    for (const number of payload.numbers) {
      try { items.push(await repliesFor(number)); }
      catch (failure) { logFailure(failure); items.push({ number, status: "error" }); }
    }
    return json(200, { schema: 1, items });
  }

  async function supplement(payload, info) {
    const key = await hashAddress(info);
    const attempt = reserveSupplementAttempt(key, now());
    if (attempt.retry) return limited(attempt.retry);
    const number = payload.number;
    // Serialize supplements for one issue, including duplicate and quota checks.
    const previous = supplementLocks.get(number) ?? Promise.resolve();
    let unlock;
    const current = new Promise((resolve) => { unlock = resolve; });
    supplementLocks.set(number, current);
    await previous;
    try {
      const { data: issue, status } = await githubJson("supplement_issue", issueURL(number), "GET", undefined, { allowMissing: true });
      if (!availableIssue(issue, "supplement_issue", status)) return error(403, "denied");
      if (issue.state !== "open" || issue.locked || issue.comments >= 100) return error(409, "closed");
      const marker = replyMarker(issue.body);
      if (!marker || !await equalHash(marker, await replyHash(payload.replyKey))) return error(403, "denied");
      const { comments } = await commentsFor(number, "supplement_comments");
      const marked = comments.filter((comment) => comment.user?.id === maintainerId && comment.body?.startsWith(SUPPLEMENT_PREFIX));
      const duplicate = marked.find((comment) => comment.body.startsWith(`${SUPPLEMENT_PREFIX}request=${payload.requestId} -->`));
      if (duplicate) return json(200, { number, commentId: commentId(duplicate, "supplement_comments"), duplicate: true });
      const at = now();
      const recent = new Map();
      for (const comment of marked) {
        const time = commentTime(comment.created_at, "supplement_comments");
        if (time > at - DAY) recent.set(commentId(comment, "supplement_comments"), time);
      }
      if (recent.size >= 3) return limited(Math.max(1, Math.ceil((Math.min(...recent.values()) + DAY - at) / 1000)));
      const address = reserveSupplementAddress(key, now());
      if (address.retry) return limited(address.retry);
      const global = reserveSupplementGlobal("global", now());
      if (global.retry) { address.release(); return limited(global.retry); }
      try {
        const { data: comment, status: createdStatus } = await githubJson(
          "supplement_create", issueURL(number) + "/comments", "POST", supplementContent(payload),
        );
        const id = commentId(comment, "supplement_create", createdStatus);
        replyCache.delete(number);
        return json(201, { number, commentId: id, duplicate: false });
      } catch (failure) {
        // Network/timeouts, 5xx and malformed successful responses may have created
        // a comment. Keep their reservations; a retry can discover the requestId.
        if (failure instanceof RelayError && (failure.kind === "paused" || failure.kind === "redirect"
            || (failure.kind === "http" && failure.status >= 400 && failure.status < 500 && failure.status !== 408))) {
          address.release();
          global.release();
        }
        throw failure;
      }
    } finally {
      unlock();
      if (supplementLocks.get(number) === current) supplementLocks.delete(number);
    }
  }

  return async (request, info) => {
    let isDevicePack = false;
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith(DEVICE_PACK_PREFIX)) {
        isDevicePack = true;
        // pathname stays encoded: never decode or reinterpret the filename.
        return devicePackResponse(await devicePack(request, info, path.slice(DEVICE_PACK_PREFIX.length)), request.method);
      }
      if (path === "/health") {
        return request.method === "GET" ? json(200, { ok: true }) : error(405, "invalid", { Allow: "GET" });
      }
      if (!["/feedback", "/feedback/replies", "/feedback/supplement"].includes(path)) return error(404, "invalid");
      if (request.method !== "POST") return error(405, "invalid", { Allow: "POST" });

      const { payload, failure } = await readPayload(request, path);
      if (failure) return failure;
      if (path === "/feedback/replies") {
        const paused = pauseSeconds();
        if (paused) return error(503, "unavailable", { "Retry-After": String(paused) });
        return await replies(payload, info);
      }
      if (disabled || typeof token !== "string" || !token) return error(503, "disabled");
      const paused = pauseSeconds();
      if (paused) return error(503, "unavailable", { "Retry-After": String(paused) });
      if (path === "/feedback/supplement") return await supplement(payload, info);

      const key = await hashAddress(info);
      const at = now();
      const { entry, retry } = reserve(key, at);
      if (!entry) return limited(retry);
      try {
        // Both searches must succeed; an upstream error must never open the gate.
        const counts = await Promise.allSettled([
          searchCount("search_hour", at - HOUR), searchCount("search_day", at - DAY),
        ]);
        // Prefer the hour search when both fail, regardless of completion order.
        const failed = counts.find((count) => count.status === "rejected");
        if (failed) throw failed.reason;
        if (counts[0].value >= 10) return limited(3600);
        if (counts[1].value >= 40) return limited(86400);

        const content = issueContent(payload);
        if (payload.schema === 2) {
          content.body += `\n\n${REPLY_NOTICE}\n<!-- myfinder-reply:v1 sha256=${await replyHash(payload.replyKey)} -->`;
        }
        const { data: issue, status } = await githubJson("create", `https://api.github.com/repos/${repo}/issues`, "POST", content);
        if (!Number.isSafeInteger(issue?.number) || issue.number < 1) {
          throw new RelayError("create", status, "bad_body");
        }
        entry.successes.push(now());
        return json(201, { number: issue.number, url: `https://github.com/${repo}/issues/${issue.number}`,
          ...(payload.schema === 2 ? { replyAccess: true } : {}) });
      } finally {
        entry.pending--;
        if (!entry.pending && !entry.successes.length) addresses.delete(key);
      }
    } catch (failure) {
      logFailure(failure);
      let paused = 0;
      try { if (!isDevicePack) paused = pauseSeconds(); } catch { /* Keep unexpected failures sanitized. */ }
      if (paused) return error(503, "unavailable", { "Retry-After": String(paused) });
      const response = error(502, "unavailable");
      return isDevicePack ? devicePackResponse(response, request.method) : response;
    }
  };
}
