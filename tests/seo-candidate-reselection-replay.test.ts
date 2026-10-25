import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { hasResearchableCandidate } from "../src/seo-candidate-quality.ts";
import {
  currentInputPreflightOptions,
  inputPreflight,
} from "../src/seo-input-preflight.ts";
import { sourceIdentity } from "../src/seo-content.ts";
import { seoSite } from "../src/sites.ts";

// Opt-in local replay: read immutable Git objects in memory; never save or print
// manuscript bodies. CI uses the synthetic regressions in the normal suites.
it.skipIf(!process.env.CMS_RESELECTION_REPLAY_ROOT)(
  "replays immutable real candidates and negative controls without AI or manuscript retention",
  () => {
    const root = process.env.CMS_RESELECTION_REPLAY_ROOT!;
    const ref = "b367fd13ca80257178c9ac0397fdbb2caa60c1ab";
    const spec = seoSite("systems")!;
    const read = (path: string) =>
      execFileSync(
        "git",
        ["-C", root + "/acecore-systems", "show", ref + ":" + path],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    for (const [slug, hash, candidate, overflow] of [
      [
        "astro-i18n-blog-translation",
        "5dc1f70ec9b598ef40a2c6ac3bd090cc212f0bc98ea3e2389dfe2caa0fdbc199",
        true,
        false,
      ],
      [
        "hatt-homepage-launch",
        "6b22277ec6bfcf8b98d3b19c8dbc860733d7e202f31f2bc20b37556929a296ed",
        false,
        false,
      ],
      [
        "ai-monkey-testing-methodology",
        "94b96604a06da531989df69271d7ec556c1cfc61babd3fcb80a4c5e1890bbabd",
        false,
        false,
      ],
      [
        "cloudflare-vectorize-safe-implementation",
        "c9b6d245112649fa1a51b1f23010aa97c9facef5dda1151830b73cebbef99d02",
        true,
        true,
      ],
    ] as const) {
      const path = "src/content/insights/" + slug + ".md",
        content = read(path);
      expect(createHash("sha256").update(content).digest("hex")).toBe(hash);
      expect(hasResearchableCandidate(content)).toBe(candidate);
      const files = [
        { path, content },
        ...spec.guidance.map((path) => ({ path, content: read(path) })),
      ];
      const identity = sourceIdentity(
        "systems",
        "https://systems.acecore.net/en/insights/" + slug + "/",
        files,
        Date.now(),
        2,
      )!;
      expect(identity.source.path).toBe(path);
      const p = inputPreflight(
        spec.site,
        identity,
        files,
        hash,
        "",
        currentInputPreflightOptions(spec.site.id),
      );
      expect(p.sizeReasons).toEqual(overflow ? ["plan_input_exceeded"] : []);
      console.log(
        JSON.stringify({
          path,
          sourceSha256: hash,
          candidate,
          planBytes: p.planBytes,
          reviewBytes: p.reviewBytes,
          generationBytes: p.generationInputs.map((x) => x.bytes),
          sizeReasons: p.sizeReasons,
        }),
      );
    }
  },
);
