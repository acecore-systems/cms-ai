import { WorkerEntrypoint } from "cloudflare:workers";
import type { AppEnv } from "./env.ts";
import { seoConnectionContract } from "./seo-contract.ts";

// Only an explicitly configured Service Binding can call this named entrypoint.
// No HTTP route, Access bypass, token export, inference, D1 write or GitHub dispatch.
export class SeoConnection extends WorkerEntrypoint<AppEnv> {
  async fetch() {
    return new Response(null, { status: 404 });
  }

  async readiness() {
    return seoConnectionContract();
  }
}
