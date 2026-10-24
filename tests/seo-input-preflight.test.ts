import { expect, it } from "vitest";
import {
  inputPreflight,
  assessInputSizes,
  currentInputPreflightOptions,
} from "../src/seo-input-preflight.ts";
import { sourceIdentity } from "../src/seo-content.ts";
import { seoSite } from "../src/sites.ts";
import { sha256 } from "../src/seo-hash.ts";
import { stageBudget } from "../src/seo-stage-budget.ts";

it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
  "uses the full %i-language proportional pool and retains every source",
  async (count) => {
    const spec = seoSite("systems")!;
    const content =
      '---\ntitle: Test\ndate: "2026-10-01"\n---\nExternal product supports complete configuration settings.';
    const files = [
      { path: "src/content/insights/example.md", content },
      ...spec.locales.map((locale) => ({
        path: `src/content/insights/${locale}/example.md`,
        content: content + locale,
      })),
      ...spec.guidance.map((path) => ({ path, content: "Original guide." })),
    ];
    const article = sourceIdentity(
      "systems",
      "https://systems.acecore.net/insights/example/",
      files,
    )!;
    article.translations = article.translations.slice(0, count - 1);
    const actualFiles = files.filter(
      (f) =>
        f.path === article.source.path ||
        article.translations.some((t) => t.path === f.path) ||
        f.path.startsWith("docs/"),
    );
    const saved = JSON.stringify(actualFiles);
    const options = {
      ...currentInputPreflightOptions(spec.site.id),
      editorial_scope: 1 as const,
    };
    const preflight = inputPreflight(
      spec.site,
      article,
      actualFiles,
      await sha256(content),
      "actual reason",
      options,
    );
    expect(preflight.sizeReasons).toEqual([]);
    expect(preflight.baseline).toHaveLength(count);
    expect(
      preflight.generationAllocation!.reduce((n, a) => n + a.maxBytes, 0),
    ).toBe(Math.floor((525000 * count) / 9));
    expect(JSON.stringify(actualFiles)).toBe(saved);
    expect(stageBudget(2, 2).maximum).toBe(1249533);
    const empty = inputPreflight(
      spec.site,
      article,
      actualFiles,
      await sha256(content),
      "",
      options,
    );
    expect(empty.planBytes).toBe(preflight.planBytes);
    expect(empty.reviewBytes).toBe(preflight.reviewBytes);
    expect(
      empty.generationInputs.every(
        (x, i) => x.bytes <= preflight.generationInputs[i].bytes,
      ),
    ).toBe(true);
  },
);

it.each(
  [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((count) =>
    [1, 2].map((version) => [count, version]),
  ),
)(
  "rejects one byte over each cap, accepts exact cap for %i locales review v%i",
  (count, version) => {
    const options = {
      ...currentInputPreflightOptions("acecore-systems"),
      review_output: version as 1 | 2,
    };
    const cap = version === 2 ? 440000 : 500000;
    const pool = Math.floor((525000 * count) / 9);
    const inputs = Array.from({ length: count }, (_, i) => ({
      path: i + ".md",
      bytes: i === 0 ? pool - count + 1 : 1,
    }));
    expect(assessInputSizes(32000, cap, inputs, options).sizeReasons).toEqual(
      [],
    );
    expect(assessInputSizes(32001, cap, inputs, options).sizeReasons).toEqual([
      "plan_input_exceeded",
    ]);
    expect(
      assessInputSizes(32000, cap + 1, inputs, options).sizeReasons,
    ).toEqual(["baseline_review_input_exceeded"]);
    inputs[0].bytes++;
    expect(assessInputSizes(32000, cap, inputs, options).sizeReasons).toEqual([
      "baseline_generation_input_exceeded",
    ]);
  },
);
