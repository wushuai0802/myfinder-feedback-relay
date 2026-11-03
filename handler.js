const DEFAULT_REPO = "wushuai0802/myfinder-device-battery";
const MAX_BODY_BYTES = 32768;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_ADDRESSES = 10000;
const GITHUB_TIMEOUT = 10000;
const CATEGORIES = Object.freeze({
  device: "设备不识别",
  battery: "电量或 DPI 不对",
  ui: "界面或操作",
  other: "其他",
});
const FIELDS = ["schema", "category", "description", "diagnostics", "appVersion"];

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
} = {}) {
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

  async function githubJson(url, method = "GET", body) {
    const controller = new AbortController();
    let timeout;
    try {
      return await Promise.race([
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("unavailable"));
          }, GITHUB_TIMEOUT);
        }),
        (async () => {
          const response = await fetchImpl(url, {
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
          if (!response.ok) throw new Error("unavailable");
          return await response.json();
        })(),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function searchCount(since) {
    const url = new URL("https://api.github.com/search/issues");
    url.searchParams.set("q", `repo:${repo} label:in-app-feedback created:>=${new Date(since).toISOString()}`);
    url.searchParams.set("per_page", "1");
    const data = await githubJson(url.href);
    if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || data.incomplete_results === true) {
      throw new Error("unavailable");
    }
    return data.total_count;
  }

  return async (request, info) => {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health") {
        return request.method === "GET" ? json(200, { ok: true }) : error(405, "invalid", { Allow: "GET" });
      }
      if (path !== "/feedback") return error(404, "invalid");
      if (request.method !== "POST") return error(405, "invalid", { Allow: "POST" });

      const { payload, failure } = await readPayload(request);
      if (failure) return failure;
      if (disabled || typeof token !== "string" || !token.trim()) return error(503, "disabled");

      const key = await hashAddress(info);
      const at = now();
      const { entry, retry } = reserve(key, at);
      if (!entry) return limited(retry);
      try {
        // Both searches must succeed; an upstream error must never open the gate.
        const counts = await Promise.allSettled([searchCount(at - HOUR), searchCount(at - DAY)]);
        if (counts.some((count) => count.status === "rejected")) return error(502, "unavailable");
        if (counts[0].value >= 10) return limited(3600);
        if (counts[1].value >= 40) return limited(86400);

        const issue = await githubJson(`https://api.github.com/repos/${repo}/issues`, "POST", issueContent(payload));
        if (!Number.isSafeInteger(issue?.number) || issue.number < 1) return error(502, "unavailable");
        entry.successes.push(now());
        return json(201, { number: issue.number, url: `https://github.com/${repo}/issues/${issue.number}` });
      } finally {
        entry.pending--;
        if (!entry.pending && !entry.successes.length) addresses.delete(key);
      }
    } catch {
      // Never return or log upstream exceptions, request data, addresses or secrets.
      return error(502, "unavailable");
    }
  };
}
