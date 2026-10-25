import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { continuationFixture } from "./fixtures/seo-review-continuation.ts";
import {
  sameContinuationSource,
  reviewContinuationProof,
  inspectReviewContinuation,
} from "../src/seo-review-continuation.ts";
import {
  startReviewContinuation,
  handleSeoRunnerRequest,
} from "../src/seo-editorial.ts";
import { seoSite } from "../src/sites.ts";
const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  workflow: vi.fn(),
  absent: vi.fn(),
  identity: null as any,
}));
vi.mock("../src/github.ts", () => ({
  dispatchSeoEditorialJob: mocks.dispatch,
  seoWorkflowCompleted: mocks.workflow,
  seoPublicationAbsent: mocks.absent,
}));
vi.mock("../src/oidc.ts", () => ({
  authenticateRunner: async () => mocks.identity,
}));
const now = Date.parse("2026-10-25T07:00:00Z"),
  newRunId = "editorial-99999999-9999-4999-8999-999999999999";
let f: Awaited<ReturnType<typeof continuationFixture>>;
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  mocks.dispatch.mockReset();
  mocks.workflow.mockReset().mockResolvedValue(true);
  mocks.absent.mockReset().mockResolvedValue(true);
  f = await continuationFixture(now);
});
afterEach(() => {
  f?.db.close();
  vi.restoreAllMocks();
});
const input = () => ({
  oldRunId: f.oldRunId,
  newRunId,
  deadline: Date.now() + 1800000,
});
async function start() {
  const p = await reviewContinuationProof(f.env, input());
  expect(p.status).toBe("eligible");
  return startReviewContinuation(f.env, {
    oldRunId: f.oldRunId,
    runId: newRunId,
    deadline: input().deadline,
    manifestSha256: (p as any).manifestSha256,
  });
}
async function request(jobId: string, op = "", body?: any) {
  const r = await handleSeoRunnerRequest(
    new Request(
      "https://cms-ai.acecore.net/seo-runner/jobs/" +
        jobId +
        (op ? "/" + op : ""),
      {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ),
    f.env,
  );
  return r!.json() as any;
}
async function claim() {
  const s = await start();
  expect(s.status).toBe("started");
  const id = (s as any).jobId;
  mocks.identity = {
    site: seoSite("portal")!.site,
    runId: "456",
    workflowSha: "f".repeat(40),
  };
  expect((await request(id)).policy.reviewContinuation).toBe(1);
  expect(
    (
      await request(id, "claim", {
        baseSha: "f".repeat(40),
        files: f.files.map(({ path, content }) => ({ path, content })),
        editorialScope: 2,
        generationOutput: 2,
        reviewContinuation: 1,
      })
    ).status,
  ).toBe("claimed");
  return id;
}
it("produces exact proof and new-job receipt while old rows remain unchanged", async () => {
  const old = f.db
    .prepare("SELECT * FROM seo_editorial_jobs WHERE id=?")
    .get(f.oldJobId);
  const p = await reviewContinuationProof(f.env, input());
  expect(Object.keys(p).sort()).toEqual(
    "articleKey,checkedAt,deadline,filesSha256,manifestSha256,newRunId,oldJobId,oldRunId,sourceSha256,status,version"
      .split(",")
      .sort(),
  );
  const id = await claim();
  expect(mocks.workflow).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "123",
    "a".repeat(40),
    now + 120000,
    "failure",
    true,
  );
  const ai = vi.fn(async (model, payload, options) => {
    expect(payload.reasoning_effort).toBe("low");
    expect(payload.max_completion_tokens).toBe(24000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return {
      model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              verdict: "pass",
              files: f.final.map((file) => ({
                path: file.path,
                meaningPreserved: true,
                naturalLanguage: true,
                referencesSupported: true,
                issues: [],
              })),
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 100 },
    };
  });
  f.env.AI = { run: ai };
  expect((await request(id, "review", { files: f.final })).status).toBe(
    "reviewed",
  );
  expect(
    (await request(id, "publish", { filesSha256: f.finalHash })).status,
  ).toBe("publishing");
  expect(
    (
      await request(id, "finish", {
        prUrl: "https://github.com/acecore-systems/aceserver-portal/pull/123",
      })
    ).status,
  ).toBe("draft_pr");
  expect(ai).toHaveBeenCalledTimes(1);
  expect(
    f.db.prepare("SELECT * FROM seo_editorial_jobs WHERE id=?").get(f.oldJobId),
  ).toEqual(old);
  expect(
    f.db
      .prepare("SELECT generation_started FROM seo_editorial_jobs WHERE id=?")
      .get(id)!.generation_started,
  ).toBe(0);
  expect(
    f.db.prepare("SELECT phase FROM seo_model_calls WHERE job_id=?").all(id),
  ).toEqual([{ phase: "review" }]);
});
it.each([
  "timeout",
  "content",
  "usage",
  "source",
  "step",
  "missing",
  "normalized",
  "github",
  "refs",
  "future",
  "stale",
  "budget",
])("denies %s before dispatch or a new AI call", async (kind) => {
  if (["timeout", "content", "usage"].includes(kind)) {
    const key = `seo-provider-responses/${f.ids.review}.json`,
      raw = JSON.parse(f.objects.get(key)!);
    if (kind === "timeout") raw.choices[0].finish_reason = "stop";
    if (kind === "content") raw.choices[0].message.content = "partial";
    if (kind === "usage") raw.usage.completion_tokens = 23999;
    f.objects.set(key, JSON.stringify(raw));
  }
  if (kind === "source" || kind === "step") {
    const key = f.key(kind === "source" ? "source" : "step-0");
    f.objects.set(
      key,
      f.objects.get(key)!.replace("ExampleEngine", "ChangedEngine"),
    );
  }
  if (kind === "missing") f.objects.delete(f.key("research"));
  if (kind === "normalized")
    f.objects.set(`seo-responses/${f.ids.review}.json`, "{}");
  if (kind === "github") mocks.workflow.mockResolvedValue(false);
  if (kind === "refs") mocks.absent.mockResolvedValue(false);
  if (kind === "future")
    f.db
      .prepare("UPDATE seo_editorial_runs SET deadline=? WHERE run_id=?")
      .run(now + 1, f.oldRunId);
  if (kind === "stale") vi.mocked(Date.now).mockReturnValue(now + 86400000);
  if (kind === "budget") {
    const prepare = f.env.CMS_AI_DB.prepare;
    f.env.CMS_AI_DB.prepare = (q: string) =>
      q.includes("COALESCE(SUM(reserved_micros)")
        ? { bind: () => ({ first: async () => ({ total: 13350000 }) }) }
        : prepare(q);
  }

  expect((await reviewContinuationProof(f.env, input())).status).toBe("denied");
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
it.each([
  "old-runner",
  "changed-source",
  "regenerate",
  "research",
  "changed-final",
  "publish-without-review",
])("blocks %s without AI or publication", async (kind) => {
  const s = await start(),
    id = (s as any).jobId;
  mocks.identity = {
    site: seoSite("portal")!.site,
    runId: "456",
    workflowSha: "f".repeat(40),
  };
  await request(id);
  const files = structuredClone(f.files);
  if (kind === "changed-source") files[0].content += "\nchanged";
  const c = await request(id, "claim", {
    baseSha: "f".repeat(40),
    files,
    editorialScope: 2,
    generationOutput: 2,
    ...(kind === "old-runner" ? {} : { reviewContinuation: 1 }),
  });
  if (["old-runner", "changed-source"].includes(kind))
    expect(c.status).toBe("unresolved");
  else {
    expect(c.status).toBe("claimed");
    const op =
      kind === "regenerate"
        ? "propose"
        : kind === "research"
          ? "research"
          : kind === "changed-final"
            ? "review"
            : "publish";
    const body =
      op === "propose"
        ? { step: 1 }
        : op === "review"
          ? { files: [{ ...f.final[0], content: f.final[0].content + "x" }] }
          : op === "publish"
            ? { filesSha256: f.finalHash }
            : {};
    expect((await request(id, op, body)).status).toBe("unresolved");
  }
  if (kind === "changed-source") {
    const failure = JSON.parse(
      f.objects.get(`seo-editorial/${id}/failure.json`)!,
    );
    expect(failure.code).toBe("seo_continuation_source");
    expect(JSON.stringify(failure)).not.toContain(files[0].content);
  }
  expect(
    f.db
      .prepare("SELECT count(*) n FROM seo_model_calls WHERE job_id=?")
      .get(id)!.n,
  ).toBe(0);
});
it("never dispatches twice or permits another new job for the same old work", async () => {
  const p = await reviewContinuationProof(f.env, input());
  const args = {
    oldRunId: f.oldRunId,
    runId: newRunId,
    deadline: input().deadline,
    manifestSha256: (p as any).manifestSha256,
  };
  const s = await startReviewContinuation(f.env, args);
  expect(await startReviewContinuation(f.env, args)).toEqual(s);
  expect(
    (
      await startReviewContinuation(f.env, {
        ...args,
        runId: newRunId.replace(/999$/, "998"),
      })
    ).status,
  ).toBe("stopped");
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
});

it("compares all exact source/guide bytes independent of JSON key and array order", () => {
  const wire = f.files.map(({ path, content }) => ({ path, content }));
  expect(JSON.stringify(wire)).not.toBe(JSON.stringify(f.files));
  expect(sameContinuationSource(wire, f.files)).toBe(true);
  expect(sameContinuationSource([...wire].reverse(), f.files)).toBe(true);
  for (const bad of [
    wire.slice(1),
    [wire[0], wire[0]],
    wire.map((v, i) => (i ? { ...v, content: v.content + " " } : v)),
    wire.map((v, i) => (i ? { ...v, extra: true } : v)),
  ])
    expect(sameContinuationSource(bad, f.files)).toBe(false);
});

async function zeroClaim() {
  const first = await start();
  expect(first.status).toBe("started");
  const id = (first as any).jobId;
  f.db
    .prepare(
      "UPDATE seo_editorial_jobs SET status='unresolved',github_run_id='789',callback_recorded=1 WHERE id=?",
    )
    .run(id);
  f.db
    .prepare("UPDATE seo_editorial_runs SET status='unresolved' WHERE run_id=?")
    .run(newRunId);
  const failure = JSON.stringify({
    operation: "claim",
    step: 1,
    code: "unexpected_error",
  });
  const { sha256 } = await import("../src/seo-hash.ts");
  f.objects.set(`seo-editorial/${id}/failure.json`, failure);
  f.objects.set(
    `seo-editorial/${id}/claim-attempts.json`,
    JSON.stringify({
      version: 1,
      jobId: id,
      runId: newRunId,
      failureSha256: await sha256(failure),
      attempts: [
        { runId: "456", headSha: "f".repeat(40) },
        { runId: "789", headSha: "e".repeat(40) },
      ],
    }),
  );
  vi.spyOn(Date, "now").mockReturnValue(now + 1800001);
  return {
    id,
    input: {
      oldRunId: newRunId,
      newRunId: "editorial-88888888-8888-4888-8888-888888888888",
      deadline: Date.now() + 1800000,
    },
  };
}
it("creates one proof-v2 retry, preserves both predecessors, and uses the normal HTTP claim gate", async () => {
  const z = await zeroClaim();
  const previousJob = f.db
    .prepare("SELECT * FROM seo_editorial_jobs WHERE id=?")
    .get(z.id);
  const previousRun = f.db
    .prepare("SELECT * FROM seo_editorial_runs WHERE run_id=?")
    .get(newRunId);
  const p = await reviewContinuationProof(f.env, z.input);
  expect(p).toMatchObject({
    status: "eligible",
    version: 2,
    oldJobId: z.id,
    oldRunId: newRunId,
  });
  expect(Object.keys(p)).toHaveLength(11);
  const args = {
    oldRunId: newRunId,
    runId: z.input.newRunId,
    deadline: z.input.deadline,
    manifestSha256: (p as any).manifestSha256,
  };
  const s = await startReviewContinuation(f.env, args);
  expect(s.status).toBe("started");
  expect(await startReviewContinuation(f.env, args)).toEqual(s);
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  const id = (s as any).jobId;
  for (const q of [
    "UPDATE seo_editorial_jobs SET status='queued' WHERE id=?",
    "DELETE FROM seo_editorial_jobs WHERE id=?",
  ])
    expect(() => f.db.prepare(q).run(z.id)).toThrow();
  expect(() =>
    f.db
      .prepare(
        "UPDATE seo_editorial_runs SET deadline=deadline+1 WHERE run_id=?",
      )
      .run(newRunId),
  ).toThrow();
  expect(() =>
    f.db
      .prepare(
        "UPDATE seo_review_continuation_retries SET created_at=created_at+1 WHERE job_id=?",
      )
      .run(id),
  ).toThrow();
  expect(() =>
    f.db
      .prepare("DELETE FROM seo_review_continuation_retries WHERE job_id=?")
      .run(id),
  ).toThrow();
  expect(
    (
      await reviewContinuationProof(f.env, {
        ...z.input,
        newRunId: z.input.newRunId.replace(/888$/, "887"),
      })
    ).status,
  ).toBe("denied");
  expect(
    (
      await reviewContinuationProof(f.env, {
        oldRunId: z.input.newRunId,
        newRunId: z.input.newRunId.replace(/888$/, "886"),
        deadline: z.input.deadline,
      })
    ).status,
  ).toBe("denied");
  mocks.identity = {
    site: seoSite("portal")!.site,
    runId: "987",
    workflowSha: "d".repeat(40),
  };
  expect((await request(id)).policy.reviewContinuation).toBe(2);
  expect(
    (
      await request(id, "claim", {
        baseSha: "d".repeat(40),
        files: f.files.map(({ path, content }) => ({ path, content })),
        editorialScope: 2,
        generationOutput: 2,
        reviewContinuation: 2,
      })
    ).status,
  ).toBe("claimed");
  expect(
    f.db.prepare("SELECT * FROM seo_editorial_jobs WHERE id=?").get(z.id),
  ).toEqual(previousJob);
  expect(
    f.db
      .prepare("SELECT * FROM seo_editorial_runs WHERE run_id=?")
      .get(newRunId),
  ).toEqual(previousRun);
  expect(
    f.db
      .prepare("SELECT count(*) n FROM seo_model_calls WHERE job_id=?")
      .get(id)!.n,
  ).toBe(0);
  const ai = vi.fn(async (model: any, payload: any) => {
    expect(payload.reasoning_effort).toBe("low");
    expect(payload.max_completion_tokens).toBe(24000);
    return {
      model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              verdict: "pass",
              files: f.final.map((file) => ({
                path: file.path,
                meaningPreserved: true,
                naturalLanguage: true,
                referencesSupported: true,
                issues: [],
              })),
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 100 },
    };
  });
  f.env.AI = { run: ai };
  expect((await request(id, "review", { files: f.final })).status).toBe(
    "reviewed",
  );
  expect(
    (await request(id, "publish", { filesSha256: f.finalHash })).status,
  ).toBe("publishing");
  expect(
    (
      await request(id, "finish", {
        prUrl: "https://github.com/acecore-systems/aceserver-portal/pull/123",
      })
    ).status,
  ).toBe("draft_pr");
  expect(ai).toHaveBeenCalledTimes(1);
  expect(
    f.db.prepare("SELECT phase FROM seo_model_calls WHERE job_id=?").all(id),
  ).toEqual([{ phase: "review" }]);
  expect(
    f.db.prepare("SELECT * FROM seo_editorial_jobs WHERE id=?").get(z.id),
  ).toEqual(previousJob);
  expect(
    f.db
      .prepare("SELECT * FROM seo_editorial_runs WHERE run_id=?")
      .get(newRunId),
  ).toEqual(previousRun);
});
it.each([
  "not-expired",
  "source",
  "review-input",
  "claim",
  "publication",
  "base",
  "workflow",
  "ref",
  "attempts",
  "failure-hash",
  "root-manifest",
  "contract",
])("rejects zero-claim retry with %s", async (kind) => {
  const z = await zeroClaim();
  if (kind === "not-expired") vi.spyOn(Date, "now").mockReturnValue(now);
  if (kind === "source" || kind === "review-input")
    f.objects.set(`seo-editorial/${z.id}/${kind}.json`, "[]");
  if (kind === "claim")
    f.db
      .prepare("UPDATE seo_editorial_jobs SET claim_recorded=1 WHERE id=?")
      .run(z.id);
  if (kind === "publication")
    f.db
      .prepare("UPDATE seo_editorial_jobs SET publication_started=1 WHERE id=?")
      .run(z.id);
  if (kind === "base")
    f.db
      .prepare("UPDATE seo_editorial_jobs SET base_sha=? WHERE id=?")
      .run("a".repeat(40), z.id);
  if (kind === "workflow") mocks.workflow.mockResolvedValue(false);
  if (kind === "ref") mocks.absent.mockResolvedValue(false);
  if (kind === "attempts" || kind === "failure-hash") {
    const key = `seo-editorial/${z.id}/claim-attempts.json`;
    const v = JSON.parse(f.objects.get(key)!);
    if (kind === "attempts") v.attempts[0].runId = "789";
    else v.failureSha256 = "0".repeat(64);
    f.objects.set(key, JSON.stringify(v));
  }
  if (kind === "root-manifest")
    f.objects.set(`seo-editorial/${z.id}/continuation-manifest.json`, "{}");
  if (kind === "contract") {
    expect(() =>
      f.db
        .prepare("UPDATE seo_editorial_jobs SET review_output=1 WHERE id=?")
        .run(z.id),
    ).toThrow();
    return;
  }
  expect((await reviewContinuationProof(f.env, z.input)).status).toBe("denied");
  expect(
    f.db
      .prepare("SELECT count(*) n FROM seo_review_continuation_retries")
      .get()!.n,
  ).toBe(0);
});
it("uses real workerd R2 conditional put without overwriting the original failure", async () => {
  const m = await import("miniflare");
  const options = {
    modules: true,
    script: "export default {fetch(){return new Response(null)}}",
    compatibilityDate: "2026-09-01",
    r2Buckets: ["R2"],
  };
  const mf = new m.Miniflare(
    (m as any).convertV4MiniflareOptions
      ? (m as any).convertV4MiniflareOptions(options)
      : options,
  );
  try {
    const z = await zeroClaim();
    const bucket = await mf.getR2Bucket("R2");
    for (const [key, value] of f.objects) await bucket.put(key, value);
    f.env.CMS_AI_IMAGES = bucket as any;
    const proof = await reviewContinuationProof(f.env, z.input);
    expect(proof).toMatchObject({ status: "eligible", version: 2 });
    const started = await startReviewContinuation(f.env, {
      oldRunId: newRunId,
      runId: z.input.newRunId,
      deadline: z.input.deadline,
      manifestSha256: (proof as any).manifestSha256,
    });
    expect(started.status).toBe("started");
    const id = (started as any).jobId;
    mocks.identity = {
      site: seoSite("portal")!.site,
      runId: "987",
      workflowSha: "d".repeat(40),
    };
    expect((await request(id)).policy.reviewContinuation).toBe(2);
    expect(
      (
        await request(id, "claim", {
          baseSha: "d".repeat(40),
          files: f.files.map(({ path, content }) => ({ path, content })),
          editorialScope: 2,
          generationOutput: 2,
          reviewContinuation: 2,
        })
      ).status,
    ).toBe("claimed");
    const key = `seo-editorial/${id}/source.json`;
    const saved = await (await bucket.get(key))!.text();
    expect(saved).toBe(JSON.stringify(f.files));
    expect(
      await bucket.put(key, "changed", { onlyIf: { etagDoesNotMatch: "*" } }),
    ).toBeNull();
    expect(await (await bucket.get(key))!.text()).toBe(saved);
    const failureKey = `seo-editorial/${id}/failure.json`;
    await bucket.put(failureKey, "original");
    await request(id, "claim", {});
    expect(await (await bucket.get(failureKey))!.text()).toBe("original");
  } finally {
    await mf.dispose();
  }
}, 30000);
it("reports safe live stage/code while leaving an earlier failure unchanged", async () => {
  const s = await start();
  const id = (s as any).jobId;
  mocks.identity = {
    site: seoSite("portal")!.site,
    runId: "456",
    workflowSha: "f".repeat(40),
  };
  await request(id);
  const key = `seo-editorial/${id}/failure.json`;
  f.objects.set(key, "original");
  mocks.workflow.mockRejectedValue(
    Object.assign(new Error("private upstream body"), {
      code: "token_unavailable",
    }),
  );
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  expect(
    (
      await request(id, "claim", {
        baseSha: "f".repeat(40),
        files: f.files,
        editorialScope: 2,
        generationOutput: 2,
        reviewContinuation: 1,
      })
    ).status,
  ).toBe("unresolved");
  const record = JSON.parse(log.mock.calls.at(-1)![0]);
  expect(record).toMatchObject({
    event: "seo_continuation_claim",
    stage: "github",
    code: "token_unavailable",
    outcome: "failed",
  });
  expect(JSON.stringify(record)).not.toContain("private");
  expect(JSON.stringify(record)).not.toContain(id);
  expect(f.objects.get(key)).toBe("original");
});

it("refuses a v1 runner at a v2 claim before source or AI", async () => {
  const z = await zeroClaim();
  const p = await reviewContinuationProof(f.env, z.input);
  const s = await startReviewContinuation(f.env, {
    oldRunId: newRunId,
    runId: z.input.newRunId,
    deadline: z.input.deadline,
    manifestSha256: (p as any).manifestSha256,
  });
  expect(s.status).toBe("started");
  const id = (s as any).jobId;
  mocks.identity = {
    site: seoSite("portal")!.site,
    runId: "987",
    workflowSha: "d".repeat(40),
  };
  await request(id);
  expect(
    (
      await request(id, "claim", {
        baseSha: "d".repeat(40),
        files: f.files,
        editorialScope: 2,
        generationOutput: 2,
        reviewContinuation: 1,
      })
    ).status,
  ).toBe("unresolved");
  expect(f.objects.has(`seo-editorial/${id}/source.json`)).toBe(false);
  expect(
    f.db
      .prepare("SELECT count(*) n FROM seo_model_calls WHERE job_id=?")
      .get(id)!.n,
  ).toBe(0);
});
