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

async function readPayload(request) {
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) return { failure: error(400, "invalid") };
    if (Number(length) > MAX_BODY_BYTES) return { failure: error(413, "too_large") };
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
      if (size > MAX_BODY_BYTES) {
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

  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).length !== FIELDS.length
      || !FIELDS.every((field) => Object.hasOwn(payload, field))
      || payload.schema !== 1
      || typeof payload.category !== "string" || !Object.hasOwn(CATEGORIES, payload.category)
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
} = {}) {
  if (typeof token === "string") token = token.trim();
  const devicePack = createDevicePackMirror(fetchImpl, now);
  // Only SHA-256 keys, success timestamps and pending counts survive a request.
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

  async function githubJson(stage, url, method = "GET", body) {
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
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "myfinder-feedback-relay",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
              },
              signal: controller.signal,
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
          } catch {
            throw new RelayError(stage, 0, "network");
          }
          status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status : 0;
          if (!response.ok) throw new RelayError(stage, status, "http");
          try {
            return { data: await response.json(), status };
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
      if (path !== "/feedback") return error(404, "invalid");
      if (request.method !== "POST") return error(405, "invalid", { Allow: "POST" });

      const { payload, failure } = await readPayload(request);
      if (failure) return failure;
      if (disabled || typeof token !== "string" || !token) return error(503, "disabled");

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

        const { data: issue, status } = await githubJson(
          "create", `https://api.github.com/repos/${repo}/issues`, "POST", issueContent(payload),
        );
        if (!Number.isSafeInteger(issue?.number) || issue.number < 1) {
          throw new RelayError("create", status, "bad_body");
        }
        entry.successes.push(now());
        return json(201, { number: issue.number, url: `https://github.com/${repo}/issues/${issue.number}` });
      } finally {
        entry.pending--;
        if (!entry.pending && !entry.successes.length) addresses.delete(key);
      }
    } catch (failure) {
      // Only internally generated metadata is safe; never inspect external errors.
      const { stage, status, kind } = failure instanceof RelayError
        ? failure : { stage: "unexpected", status: 0, kind: "unexpected" };
      try {
        log(`relay_error stage=${stage} status=${status} kind=${kind}`);
      } catch {
        // A failing logger must not change the response or trigger a second log.
      }
      const response = error(502, "unavailable");
      return isDevicePack ? devicePackResponse(response, request.method) : response;
    }
  };
}
