import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../src/seo-hash.ts";
import { it, expect, vi } from "vitest";
import {
  inspectReviewContinuation,
  reviewContinuationProof,
} from "../src/seo-review-continuation.ts";
import { buildReviewRequest } from "../src/seo-checks.ts";
import { deepseekPayload, deepseekUpperCost } from "../src/seo-deepseek.ts";
import {
  startReviewContinuation,
  handleSeoRunnerRequest,
} from "../src/seo-editorial.ts";
import { sourceIdentity } from "../src/seo-content.ts";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), identity: null as any }));
vi.mock("../src/github.ts", () => ({
  dispatchSeoEditorialJob: mocks.dispatch,
  seoWorkflowCompleted: async () => true,
  seoPublicationAbsent: async () => true,
}));
vi.mock("../src/oidc.ts", () => ({
  authenticateRunner: async () => mocks.identity,
}));
// Private local fixture only: never checked into Git, never sends an AI request.
it.skipIf(!process.env.SEO_CONTINUATION_REPLAY)(
  "replays actual persisted D1/R2 review length without changing the old verdict",
  async () => {
    const base = process.env.SEO_CONTINUATION_REPLAY!,
      extra = process.env.SEO_CONTINUATION_EXTRA!;
    const state = JSON.parse(
      readFileSync(join(base, "current-state.json"), "utf8"),
    ).cms;
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=OFF");
    for (const name of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql") && n >= "0004")
      .sort())
      db.exec(
        readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"),
      );
    const triggers = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
      .all();
    for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
    for (const [table, rows] of Object.entries(state) as [string, any[]][]) {
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      for (const row of rows)
        db.prepare(
          `INSERT INTO ${table} (${cols.map((c) => '"' + c + '"').join()}) VALUES (${cols.map(() => "?").join()})`,
        ).run(...cols.map((c) => row[c]));
    }
    for (const t of triggers) db.exec(String(t.sql));
    db.exec("PRAGMA foreign_keys=ON");
    const old = state.seo_editorial_jobs.find(
      (j: any) =>
        j.status === "unresolved" &&
        state.seo_editorial_checks.some(
          (c: any) =>
            c.job_id === j.id &&
            c.phase === "review" &&
            c.status === "unresolved",
        ) &&
        existsSync(join(base, "review-call.json")) &&
        JSON.parse(
          readFileSync(join(base, "review-call.json"), "utf8"),
        ).resultKey.includes(j.id),
    );
    const run = state.seo_editorial_runs.find(
      (r: any) => r.run_id === old.run_id,
    );
    const now = Math.max(Date.now(), run.deadline + 1),
      clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const reads: string[] = [];
    const checks = state.seo_editorial_checks
      .concat(state.seo_discovery_checks)
      .filter((c: any) => c.job_id === old.id);
    const prepare = (q: string) => {
      const bound = (args: any[] = []) => ({
        query: q,
        args,
        run: async () => ({
          meta: { changes: Number(db.prepare(q).run(...args).changes) },
        }),
        bind: (...a: any[]) => bound(a),
        first: async () => db.prepare(q).get(...args) || null,
        all: async () => ({ results: db.prepare(q).all(...args) }),
      });
      return bound();
    };
    const stored = new Map<string, string>();
    const env: any = {
      SEO_GENERATION_ENABLED: "true",
      SEO_EDITORIAL_ENABLED: "true",
      SEO_RESEARCH_ENABLED: "true",
      SEO_COORDINATOR: {
        claim: async () => ({ status: "claimed" }),
        complete: async () => ({ status: "recorded" }),
      },
      CMS_AI_DB: {
        prepare,
        batch: async (stmts: any[]) => {
          db.exec("BEGIN");
          try {
            const results = [];
            for (const st of stmts) results.push(await st.run());
            db.exec("COMMIT");
            return results;
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
        },
      },
      CMS_AI_IMAGES: {
        put: async (key: string, raw: string) => {
          if (stored.has(key)) return null;
          stored.set(key, raw);
          return {};
        },
        get: async (key: string) => {
          reads.push(key);
          if (stored.has(key)) {
            const raw = stored.get(key)!;
            return { text: async () => raw, json: async () => JSON.parse(raw) };
          }
          let path: string | undefined;
          const suffix = key.split("/").at(-1)!;
          if (key.startsWith(`seo-editorial/${old.id}/`))
            path = existsSync(join(extra, suffix))
              ? join(extra, suffix)
              : join(base, suffix);
          if (key.startsWith("seo-responses/")) {
            const c = checks.find(
              (c: any) => key === `seo-responses/${c.call_id}.json`,
            );
            if (c && c.phase !== "review")
              path = join(
                c.phase === "research" ? base : extra,
                c.phase + "-response.json",
              );
          }
          if (key.startsWith("seo-provider-responses/"))
            path = join(base, "review-provider-response.json");
          if (key.startsWith("seo-proposals/"))
            path = join(extra, "proposal.json");
          if (!path || !existsSync(path)) return null;
          const raw = readFileSync(path, "utf8");
          if (!raw.trim()) return null;
          return { text: async () => raw, json: async () => JSON.parse(raw) };
        },
      },
    };
    try {
      const before = JSON.stringify(
        db.prepare("SELECT * FROM seo_editorial_jobs").all(),
      );
      const data = await inspectReviewContinuation(
        env,
        run.run_id,
        now + 1800000,
        false,
      );
      const identity = sourceIdentity(
        JSON.parse(run.candidates_json)[old.candidate_index].site,
        JSON.parse(run.candidates_json)[old.candidate_index].url,
        data.source,
        now,
        2,
      )!;
      const reviewRequest = buildReviewRequest(
        identity,
        data.source,
        data.final,
        data.evidence,
        2,
        2,
      );
      const payload = deepseekPayload(
        { ...reviewRequest, reasoning_effort: "low" },
        true,
      );
      expect(payload.reasoning_effort).toBe("low");
      expect(payload.max_completion_tokens).toBe(24000);
      expect(
        JSON.stringify(db.prepare("SELECT * FROM seo_editorial_jobs").all()),
      ).toBe(before);
      console.info(
        JSON.stringify({
          manifestSha256: data.manifestSha256,
          filesSha256: data.manifest.filesSha256,
          reviewUpperMicros: deepseekUpperCost(payload),
          requestBytes: new TextEncoder().encode(JSON.stringify(payload))
            .length,
          objectReads: reads.length,
        }),
      );
      const oldRows = Object.keys(state).map((table) => [
        table,
        JSON.stringify(db.prepare("SELECT * FROM " + table).all()),
      ]);
      const newRunId = "editorial-00000000-0000-4000-8000-000000000099";
      const deadline = now + 1800000;
      const proof = await reviewContinuationProof(env, {
        oldRunId: run.run_id,
        newRunId,
        deadline,
      });
      expect(proof.status).toBe("eligible");
      expect(Object.keys(proof).length).toBe(11);
      const start = {
        oldRunId: run.run_id,
        runId: newRunId,
        deadline,
        manifestSha256: data.manifestSha256,
      };
      const started = await startReviewContinuation(env, start);
      expect(started.status).toBe("started");
      expect(await startReviewContinuation(env, start)).toEqual(started);
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
      expect(
        (
          await startReviewContinuation(env, {
            ...start,
            runId: newRunId.replace(/099$/, "098"),
          })
        ).status,
      ).toBe("stopped");
      mocks.identity = {
        site: identity.target.spec.site,
        runId: "999999",
        workflowSha: "f".repeat(40),
      };
      const request = async (op = "", body?: any) => {
        const r = await handleSeoRunnerRequest(
          new Request(
            "https://cms-ai.acecore.net/seo-runner/jobs/" +
              (started as any).jobId +
              (op ? "/" + op : ""),
            {
              method: body === undefined ? "GET" : "POST",
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
          ),
          env,
        );
        return r!.json() as any;
      };
      expect((await request()).policy.reviewContinuation).toBe(1);
      const claimed = await request("claim", {
        baseSha: "f".repeat(40),
        files: data.source,
        editorialScope: 2,
        generationOutput: 2,
        reviewContinuation: 1,
      });
      expect(claimed.status).toBe("claimed");
      expect(await sha256(JSON.stringify(claimed.continuation.files))).toBe(
        data.manifest.filesSha256,
      );
      const ai = vi.fn(async (_model: any, payload: any) => {
        expect(payload.reasoning_effort).toBe("low");
        expect(payload.max_completion_tokens).toBe(24000);
        return {
          model: _model,
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  verdict: "pass",
                  files: data.final.map((f: any) => ({
                    path: f.path,
                    meaningPreserved: true,
                    naturalLanguage: true,
                    referencesSupported: true,
                    issues: [],
                  })),
                }),
              },
            },
          ],
          usage: { prompt_tokens: 15014, completion_tokens: 100 },
        };
      });
      env.AI = { run: ai };
      const reviewed = await request("review", { files: data.final });
      expect(reviewed.status).toBe("reviewed");
      expect(ai).toHaveBeenCalledTimes(1);
      expect(
        (await request("publish", { filesSha256: data.manifest.filesSha256 }))
          .status,
      ).toBe("publishing");
      expect(
        (
          await request("finish", {
            prUrl: `https://github.com/${identity.target.spec.site.repository}/pull/999`,
          })
        ).status,
      ).toBe("draft_pr");
      expect(
        db
          .prepare("SELECT status FROM seo_editorial_jobs WHERE id=?")
          .get(old.id)!.status,
      ).toBe("unresolved");
      expect(
        db
          .prepare(
            "SELECT generation_started FROM seo_editorial_jobs WHERE id=?",
          )
          .get((started as any).jobId)!.generation_started,
      ).toBe(0);
      expect(
        db
          .prepare("SELECT count(*) n FROM seo_model_calls WHERE job_id=?")
          .get((started as any).jobId)!.n,
      ).toBe(1);
      for (const [table, raw] of oldRows) {
        const original = JSON.parse(raw);
        const current = db.prepare("SELECT * FROM " + table).all();
        for (const row of original) expect(current).toContainEqual(row);
      }
    } finally {
      clock.mockRestore();
      db.close();
    }
  },
  30000,
);
