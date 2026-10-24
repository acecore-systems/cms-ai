import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { reconsiderationProof } from "../src/seo-reconsideration.ts";
import { sha256 } from "../src/seo-hash.ts";
import type { AppEnv } from "../src/env.ts";
const workflow = vi.hoisted(() => vi.fn());
vi.mock("../src/github.ts", () => ({ seoWorkflowCompleted: workflow }));
let sql: DatabaseSync, env: AppEnv, objects: Map<string, string>;
const source = "a".repeat(64),
  article = "portal:src/content/stories/test.md";
beforeEach(async () => {
  sql = new DatabaseSync(":memory:");
  // Synthetic historical state. The production proof SQL is executed unchanged.
  sql.exec(`CREATE TABLE seo_editorial_jobs(id,run_id,site_id,github_run_id,base_sha,source_sha256,article_key,status,generation_started,publication_started,next_step,call_id,callback_recorded,claim_recorded);
 CREATE TABLE seo_editorial_runs(run_id,job_id,article_key,status,pr_url,deadline);
 CREATE TABLE seo_research_rejections(job_id,run_id,receipt_sha256,receipt_json);
 CREATE TABLE seo_plan_contracts(job_id,version);
 INSERT INTO seo_editorial_jobs VALUES('oldjob','old','aceserver-portal','123','${"b".repeat(40)}','${source}','${article}','unresolved',0,0,0,NULL,1,1);
 INSERT INTO seo_editorial_runs VALUES('old','oldjob','${article}','unresolved',NULL,1);
 INSERT INTO seo_editorial_jobs VALUES('newjob','new','aceserver-portal','456','${"b".repeat(40)}','${source}','${article}','claiming',0,0,0,NULL,0,0);
 INSERT INTO seo_editorial_runs VALUES('new','newjob',NULL,'pending',NULL,${Date.now() + 60000});
 INSERT INTO seo_plan_contracts VALUES('newjob',2);`);
  const raw = JSON.stringify({
    reason: "confirmed_insufficient",
    runId: "old",
    jobId: "oldjob",
    articleKey: article,
    sourceSha256: source,
    generationCalls: 0,
    generationArtifacts: 0,
    publicationStarted: false,
    refs: [],
    pullRequests: [],
  });
  sql
    .prepare("INSERT INTO seo_research_rejections VALUES(?,?,?,?)")
    .run("oldjob", "old", await sha256(raw), raw);
  objects = new Map([["seo-editorial/oldjob/rejection.json", raw]]);
  const prepare = (query: string) => {
    const bound = (args: any[] = []) => ({
      bind: (...v: any[]) => bound(v),
      first: async () => sql.prepare(query).get(...args) || null,
    });
    return bound();
  };
  env = {
    SEO_RESEARCH_ENABLED: "true",
    SEO_EDITORIAL_ENABLED: "true",
    CMS_AI_DB: { prepare },
    CMS_AI_IMAGES: {
      get: async (k: string) =>
        objects.has(k) ? { text: async () => objects.get(k) } : null,
    },
  } as unknown as AppEnv;
  workflow.mockReset().mockResolvedValue(true);
});
afterEach(() => sql.close());
const input = { runId: "old", articleKey: article, newRunId: "new" };
it("proves the historical v1 receipt during the new claiming state and checks the pinned completed workflow", async () => {
  expect(await reconsiderationProof(env, input)).toMatchObject({
    status: "eligible",
    fromPlan: 1,
    toPlan: 2,
    newRunId: "new",
  });
  expect(workflow.mock.calls[0].slice(2, 4)).toEqual(["123", "b".repeat(40)]);
  expect(
    sql
      .prepare("SELECT status FROM seo_editorial_jobs WHERE id='newjob'")
      .get(),
  ).toEqual({ status: "claiming" });
});
it.each([
  "UPDATE seo_editorial_jobs SET generation_started=1 WHERE id='oldjob'",
  "UPDATE seo_editorial_jobs SET publication_started=1 WHERE id='oldjob'",
  "UPDATE seo_editorial_jobs SET callback_recorded=0 WHERE id='oldjob'",
  "UPDATE seo_editorial_jobs SET call_id='active' WHERE id='oldjob'",
  "INSERT INTO seo_plan_contracts VALUES('oldjob',2)",
  "UPDATE seo_editorial_runs SET pr_url='https://example.org' WHERE run_id='old'",
  "UPDATE seo_editorial_jobs SET source_sha256='changed' WHERE id='newjob'",
  "UPDATE seo_editorial_jobs SET status='claimed' WHERE id='newjob'",
  "UPDATE seo_editorial_runs SET deadline=1 WHERE run_id='new'",
  "UPDATE seo_research_rejections SET receipt_sha256='changed'",
])("denies unsafe or unchanged contracts: %s", async (query) => {
  sql.exec(query);
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
  expect(workflow).not.toHaveBeenCalled();
});
it("denies missing immutable object, generation artifact and incomplete/unavailable workflow", async () => {
  workflow.mockResolvedValueOnce(false);
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
  workflow.mockRejectedValueOnce(new Error("unknown"));
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
  objects.set("seo-editorial/oldjob/step-0.json", "{}");
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
  objects.delete("seo-editorial/oldjob/step-0.json");
  objects.clear();
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
});

it("caps GitHub checking at the supplied collection deadline and rejects expired deadlines before reads", async () => {
  const deadline = Date.now() + 1000;
  expect(
    await reconsiderationProof(env, {
      runId: "old",
      articleKey: article,
      deadline,
    }),
  ).toMatchObject({ status: "eligible" });
  expect(workflow.mock.calls[0][4]).toBe(deadline);
  workflow.mockClear();
  expect(await reconsiderationProof(env, { ...input, deadline: 1 })).toEqual({
    status: "denied",
  });
  expect(workflow).not.toHaveBeenCalled();
});
