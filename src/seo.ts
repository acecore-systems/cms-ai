import { WorkerEntrypoint } from "cloudflare:workers";
import type { AppEnv } from "./env.ts";
import { seoConnectionContract } from "./seo-contract.ts";
import { generateSeo, generationReadiness } from "./seo-generation.ts";

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

// Separate capability: opt-in binding, no HTTP route or CMS user-role reuse.
export class SeoGeneration extends WorkerEntrypoint<AppEnv> {
  async fetch() {
    return new Response(null, { status: 404 });
  }
  async readiness() {
    return generationReadiness(this.env);
  }
  async propose(input: unknown) {
    return generateSeo(this.env, input);
  }
}
