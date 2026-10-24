import { deepseekPayload } from "./seo-deepseek.ts";
import { validateSourceFiles } from "./inference.ts";
import { prepareEditorialTransport } from "./seo-metadata-preservation.ts";
import type { SiteConfig } from "./sites.ts";
import type { ArticleIdentity, EditorialFile } from "./seo-content.ts";
import { buildPlanRequest, buildReviewRequest } from "./seo-checks.ts";
import { externalScope } from "./seo-external-sources.ts";
import { buildEditorialInstruction } from "./seo-editorial-instruction.ts";
import { buildSeoGenerationRequest } from "./seo-generation.ts";
import { allocateGenerationInputs, stageBudget } from "./seo-stage-budget.ts";

export type InputPreflightOptions = {
  editorial_scope?: 1 | 2;
  model_version?: 1 | 2;
  generation_output?: 1 | 2;
  plan_instructions?: 1 | 2;
  site_id: string;
  research_recovery: 1 | 2;
  external_sources: number;
  discovery_policy: 2 | 3;
  generation_syntax: 1 | 2;
  retrieval_contract: number;
  budget_version: number;
  allocation_version: 1 | 2;
  code_preservation?: 1 | 2;
  review_output?: 1 | 2;
  metadata_preservation?: 1 | 2;
  code_token_repair?: 1 | 2;
};
// Current new-job contracts. No provider calls, storage writes or budget reservations.
export function currentInputPreflightOptions(
  siteId: string,
): InputPreflightOptions {
  return {
    site_id: siteId,
    editorial_scope: 2,
    plan_instructions: 2,
    generation_output: 2,
    research_recovery: 2,
    external_sources: 1,
    discovery_policy: 3,
    generation_syntax: 2,
    retrieval_contract: 2,
    budget_version: 2,
    allocation_version: 2,
    code_preservation: 2,
    review_output: 2,
    metadata_preservation: 2,
    code_token_repair: 2,
  };
}
export function inputPreflight(
  site: SiteConfig,
  article: ArticleIdentity,
  files: EditorialFile[],
  sourceHash: string,
  reason: string,
  options: InputPreflightOptions,
) {
  const paths = [
    article.source.path,
    ...article.translations.map((t) => t.path),
  ];
  const baseline = paths.map((path) => files.find((f) => f.path === path)!);
  const bytes = (request: unknown) =>
    new TextEncoder().encode(
      JSON.stringify(
        options.model_version === 2
          ? deepseekPayload(
              request as Record<string, unknown>,
              "input" in (request as object),
            )
          : request,
      ),
    ).length;
  const planBytes = planInputBytes(article.source, options);
  const reviewBytes = bytes(
    buildReviewRequest(
      article,
      files,
      baseline,
      {
        version: 1,
        checkedAt: "",
        sourceSha256: sourceHash,
        responseId: "not_acquired_size_estimate_only",
        queries: [],
        sources: [],
      },
      options.review_output,
      options.editorial_scope,
    ),
  );
  // Unknown future research/JA growth cannot be forecast. This placeholder is
  // explicitly unacquired and only rejects already oversized known inputs.
  const generationEstimateEvidence = {
    version: 1 as const,
    checkedAt: "",
    sourceSha256: sourceHash,
    responseId: "not_acquired_size_estimate_only",
    queries: [],
    sources: [],
  };
  const generationInputs = paths.map((path, step) => {
    const locale = article.translations.find((t) => t.path === path)?.locale;
    const knownFiles = files.filter(
      (f) =>
        f.path === article.source.path ||
        f.path === path ||
        f.path.startsWith("docs/"),
    );
    const instruction = buildEditorialInstruction({
      syntaxPolicy: options.generation_syntax,
      editorialScope: options.editorial_scope,
      step,
      paths,
      locale,
      translationCount: article.translations.length,
      reason: reason,
      research: generationEstimateEvidence,
    });
    const transport = prepareEditorialTransport(
      knownFiles,
      article.source.path,
      path,
      instruction,
      options.code_preservation,
      site.projectRoot,
      options.metadata_preservation,
      article.target.spec.editableFields,
      options.generation_syntax,
      options.code_token_repair,
    );
    const request = buildSeoGenerationRequest(
      site,
      article.source.path,
      [path],
      transport.instruction,
      options.code_preservation === 2 || options.metadata_preservation === 2
        ? validateSourceFiles(site, transport.files)
        : transport.files,
      options.model_version === 2 ? options.generation_output : 1,
    );
    return { path, locale: locale || "ja", bytes: bytes(request) };
  });
  return {
    baseline,
    planBytes,
    reviewBytes,
    generationInputs,
    ...assessInputSizes(planBytes, reviewBytes, generationInputs, options),
  };
}

export function assessInputSizes(
  planBytes: number,
  reviewBytes: number,
  generationInputs: { path: string; bytes: number }[],
  options: InputPreflightOptions,
) {
  let generationAllocation:
    ReturnType<typeof allocateGenerationInputs> | undefined;
  if (options.retrieval_contract === 2) {
    try {
      generationAllocation = allocateGenerationInputs(
        generationInputs,
        options.budget_version,
        options.allocation_version,
      );
    } catch {
      /* ineligible, no paid call */
    }
  }

  const sizeReasons = [
    ...(planBytes > stageBudget(options.budget_version).limits.plan
      ? ["plan_input_exceeded"]
      : []),
    ...(reviewBytes >
    stageBudget(options.budget_version, 1, options.review_output).limits.review
      ? ["baseline_review_input_exceeded"]
      : []),
    ...((
      options.retrieval_contract === 2
        ? !generationAllocation
        : generationInputs.some(
            (input) =>
              input.bytes >
              stageBudget(options.budget_version).limits.generation,
          )
    )
      ? ["baseline_generation_input_exceeded"]
      : []),
  ];
  return { generationAllocation, sizeReasons };
}

export function planInputBytes(
  source: EditorialFile,
  options: InputPreflightOptions,
) {
  return new TextEncoder().encode(
    JSON.stringify(
      (options.model_version === 2
        ? (r: Record<string, unknown>) => deepseekPayload(r, true)
        : (r: Record<string, unknown>) => r)(
        buildPlanRequest(
          source.content,
          2,
          options.research_recovery === 2
            ? 5
            : options.external_sources
              ? 4
              : options.discovery_policy,
          options.external_sources
            ? externalScope(options.site_id, source)
            : undefined,
          options.research_recovery,
          options.plan_instructions,
        ),
      ),
    ),
  ).length;
}
