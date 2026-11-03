import { createHandler } from "./handler.js";

// Importing this entry point in Node (or as a Deno library) starts no server.
if (typeof Deno !== "undefined" && import.meta.main) {
  const handler = createHandler({
    token: Deno.env.get("FEEDBACK_GITHUB_TOKEN")?.trim(),
    repo: Deno.env.get("FEEDBACK_REPO") || undefined,
    disabled: Deno.env.get("FEEDBACK_DISABLED") === "1",
  });
  Deno.serve((request, info) => handler(request, info.remoteAddr?.hostname));
}
