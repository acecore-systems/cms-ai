import { seoRepositoryReader } from "./github.ts";
import { seoSite } from "./sites.ts";
import { editorialEligibility } from "./seo-eligibility.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { AppEnv } from "./env.ts";
import { seoConnectionContract } from "./seo-contract.ts";
import { generateSeo, generationReadiness } from "./seo-generation.ts";
import {
  startEditorial,
  fallbackReport,
  editorialStatus,
  editorialReport,
} from "./seo-editorial.ts";

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

// Explicit capability, separate from the read-only connection and proposal RPCs.
export class SeoEditorial extends WorkerEntrypoint<AppEnv> {
  async eligibility(input: unknown) {
    const v = input as { site?: string; deadline?: number };
    const spec = v && typeof v.site === "string" ? seoSite(v.site) : null;
    if (!spec) throw new Error("seo_eligibility_unknown");
    return editorialEligibility(
      input,
      seoRepositoryReader(this.env, spec.site, v.deadline!),
    );
  }
  async fetch() {
    return new Response(null, { status: 404 });
  }
  async start(input: unknown) {
    return startEditorial(this.env, input);
  }
  async startAttempt(input: {
    version: 1;
    rootRunId: string;
    ordinal: number;
    previousReceiptSha256: string | null;
    runId: string;
    deadline: number;
    candidates: unknown[];
  }) {
    const {
      version,
      rootRunId,
      ordinal,
      previousReceiptSha256,
      runId,
      deadline,
      candidates,
    } = input;
    return startEditorial(
      this.env,
      { runId, deadline, candidates },
      { version, rootRunId, ordinal, previousReceiptSha256 },
    );
  }
  async trialReport(input: { runId: string }) {
    return fallbackReport(this.env, input);
  }
  async report(input: unknown) {
    return editorialReport(this.env, input);
  }
  async status(input: unknown) {
    return editorialStatus(this.env, input);
  }
}
