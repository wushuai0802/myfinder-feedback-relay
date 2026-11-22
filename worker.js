// Cloudflare Workers entry for the MyFinder feedback relay.
// The request handling itself is unchanged: handler.js from wushuai0802/myfinder-feedback-relay.
import { createHandler } from "./handler.js";

let handler = null;
let configKey = "";
let handlerToken;

export default {
  async fetch(request, env) {
    const token = typeof env.FEEDBACK_GITHUB_TOKEN === "string" ? env.FEEDBACK_GITHUB_TOKEN.trim() : undefined;
    const key = [token ? "t" : "-", env.FEEDBACK_REPO || "", env.FEEDBACK_DISABLED || ""].join("|");
    // Cloudflare can keep this module alive when only the bindings change.
    if (!handler || key !== configKey || token !== handlerToken) {
      handler = createHandler({
        token,
        repo: env.FEEDBACK_REPO || undefined,
        disabled: env.FEEDBACK_DISABLED === "1",
      });
      configKey = key;
      handlerToken = token;
    }
    return handler(request, request.headers.get("CF-Connecting-IP") || undefined);
  },
};
