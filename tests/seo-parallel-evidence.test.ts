import { expect, it } from "vitest";
import { parallelEvidence } from "../src/seo-parallel-evidence.ts";
import { sha256 } from "../src/seo-hash.ts";
import { parsePlan, researchInputs } from "../src/seo-research-plan.ts";

it("binds an actual allowed searched URL and exact retrieved-body quote to the fixed plan", async () => {
  const source =
    "---\ntitle: Test\n---\n\nPlaywright supports browser automation across multiple platforms.";
  const sourceSha256 = await sha256(source);
  const claim = researchInputs(source).claims[0];
  const plan = parsePlan(
    {
      verdict: "ready",
      claimId: claim.id,
      targetQuote: claim.markdown,
      conditions: [claim.markdown],
      anchors: ["Playwright"],
      queries: ["Playwright browser automation"],
    },
    source,
    sourceSha256,
    2,
  );
  const excerpt =
    "Playwright supports browser automation across multiple platforms.";
  const rawBody = `<html><head><title>ignore</title></head><main><p>Playwright supports <strong>browser automation</strong> across multiple platforms.</p><script>fabricated hidden text</script><div hidden>ignored text</div></main></html>`;
  const input = {
    source,
    sourceSha256,
    plan,
    scope: {
      sourceUrl: "https://acecore.net/a/",
      excludedHosts: ["acecore.net"],
    },
    searchedUrls: ["https://playwright.dev/docs/intro"],
    selectedUrl: "https://playwright.dev/docs/intro",
    candidateTitle: "Official",
    suppliedText: excerpt,
    body: new TextEncoder().encode(rawBody),
    bodySha256: await sha256(rawBody),
    retrievedAt: Date.now(),
    deadline: Date.now() + 60000,
    modelResponseId: "resp_fixture",
    result: {
      verdict: "verified",
      assessment: "supports",
      claimId: plan.claimId,
      url: "https://playwright.dev/docs/intro",
      title: "Official",
      excerpt,
    },
  };
  const evidence = await parallelEvidence(input);
  expect(evidence.version).toBe(2);
  expect(evidence.source.excerpt).toBe(excerpt);
  expect(evidence.source.textSha256).toBe(await sha256(excerpt));
  expect(evidence.source.excerptStart).toBe(0);
  expect(evidence.source.excerptEnd).toBe(excerpt.length);
  await expect(
    parallelEvidence({
      ...input,
      result: {
        ...input.result,
        excerpt: "This fabricated quote never appeared on the page.",
      },
    }),
  ).rejects.toThrow();
  await expect(
    parallelEvidence({ ...input, bodySha256: "0".repeat(64) }),
  ).rejects.toThrow();
  await expect(
    parallelEvidence({ ...input, searchedUrls: [] }),
  ).rejects.toThrow();
  await expect(
    parallelEvidence({ ...input, selectedUrl: "https://evil.invalid/" }),
  ).rejects.toThrow();
});
