import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { continuationFixture } from "./fixtures/seo-review-continuation.ts";
import {
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
        files: f.files,
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
    input().deadline,
    "failure",
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
