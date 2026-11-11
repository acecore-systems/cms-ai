import { build } from "esbuild";
import * as miniflare from "miniflare";
import { expect, it } from "vitest";

it("normal Worker and service entrypoints stop legacy Luna while history remains readable", async () => {
  const compiled = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    conditions: ["workerd"],
    format: "esm",
    external: ["cloudflare:workers"],
    plugins: [
      {
        name: "seo-entry-fixture",
        setup(b) {
          b.onLoad({ filter: /[\\/]seo-editorial\.ts$/ }, () => ({
            loader: "ts",
            contents: `
        export async function handleSeoRunnerRequest(){return Response.json({status:'history-readable'})}
        export async function startEditorial(){throw Error('must not dispatch')}
        export async function startReviewContinuation(){throw Error('must not dispatch')}
        export async function fallbackReport(){return {}}
        export async function editorialStatus(){return {}}
        export async function editorialReport(){return {}}`,
          }));
        },
      },
    ],
  });
  const options = {
    workers: [
      {
        name: "caller",
        compatibilityDate: "2026-09-01",
        modules: true,
        script: `export default {async fetch(req,env){const url=new URL(req.url); if(url.pathname==='/rpc') return Response.json({generation:await env.GEN.propose({}), readiness:await env.GEN.readiness(), start:await env.EDITOR.start({}), continuation:await env.EDITOR.startReviewContinuation({})}); return env.CMS.fetch(req)}}`,
        serviceBindings: {
          CMS: { name: "cms" },
          GEN: { name: "cms", entrypoint: "SeoGeneration" },
          EDITOR: { name: "cms", entrypoint: "SeoEditorial" },
        },
      },
      {
        name: "cms",
        compatibilityDate: "2026-09-01",
        modules: true,
        script: compiled.outputFiles[0].text,
        bindings: { SEO_SEARCH_PROVIDER: "luna-legacy" },
      },
    ],
  };
  const convert = (miniflare as any).convertV4MiniflareOptions;
  const mf = new miniflare.Miniflare(convert ? convert(options) : options);
  try {
    const legacy = await mf.dispatchFetch(
      "http://local/seo-runner/jobs/00000000-0000-4000-8000-000000000000/research",
      { method: "POST" },
    );
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toEqual({
      status: "retired",
      reason: "seo_legacy_model_retired",
    });
    const read = await mf.dispatchFetch(
      "http://local/seo-runner/jobs/00000000-0000-4000-8000-000000000000",
    );
    expect(await read.json()).toEqual({ status: "history-readable" });
    const rpc: any = await (await mf.dispatchFetch("http://local/rpc")).json();
    expect(rpc.generation).toEqual({
      status: "retired",
      reason: "seo_legacy_model_retired",
    });
    expect(rpc.readiness.enabled).toBe(false);
    expect(rpc.start).toEqual({
      status: "retired",
      reason: "seo_legacy_model_retired",
    });
    expect(rpc.continuation).toEqual({
      status: "retired",
      reason: "seo_legacy_model_retired",
    });
  } finally {
    await mf.dispose();
  }
}, 30000);
