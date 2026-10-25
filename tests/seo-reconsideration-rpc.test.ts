import { it, expect } from "vitest";
import { build } from "esbuild";
import * as miniflare from "miniflare";
import { sha256 } from "../src/seo-hash.ts";

it("real Service Binding re-entry observes claiming before proof and returns before claimed", async () => {
  const article = "portal:src/content/stories/test.md",
    source = "a".repeat(64);
  const receipt = JSON.stringify({
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
  const old = {
    id: "oldjob",
    site_id: "aceserver-portal",
    github_run_id: "123",
    base_sha: "b".repeat(40),
    source_sha256: source,
    receipt_sha256: await sha256(receipt),
    receipt_json: receipt,
  };
  const compiled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
 import {WorkerEntrypoint} from 'cloudflare:workers';
 import {reconsiderationProof} from './src/seo-reconsideration.ts';
 let state='inspecting';
 export class Cms extends WorkerEntrypoint {
  async start() {state='claiming';const response=await this.env.SEO.claim();if(response.status==='claimed')state='claimed';return {response,state};}
  async reconsideration(input) {
   const old=JSON.parse(this.env.OLD);
   const env={SEO_EDITORIAL_ENABLED:'true',SEO_RESEARCH_ENABLED:'true',
    CMS_AI_DB:{prepare:query=>({bind:()=>({first:async()=>query.includes('x.receipt_sha256')?old:state==='claiming'?{id:'newjob',deadline:Date.now()+60000}:null})})},
    CMS_AI_IMAGES:{get:async key=>key.endsWith('/rejection.json')?{text:async()=>old.receipt_json}:null}};
   return reconsiderationProof(env,input);
  }
 }
 export default {fetch(){return new Response(null,{status:404})}};`,
    },
    bundle: true,
    write: false,
    platform: "browser",
    conditions: ["workerd"],
    format: "esm",
    external: ["cloudflare:workers"],
    plugins: [
      {
        name: "no-network-fixture",
        setup(b) {
          b.onLoad({ filter: /[\\/]github\.ts$/ }, () => ({
            contents:
              "export async function seoWorkflowCompleted(){return true} export async function seoPublicationAbsent(){return true}",
            loader: "ts",
          }));
        },
      },
    ],
  });
  const worker = (name: string, contents: string, env: any) => ({
    name,
    compatibilityDate: "2026-09-01",
    modules: true,
    script: contents,
    bindings: Object.fromEntries(
      Object.entries(env)
        .filter(([, v]: any) => v.type === "text")
        .map(([k, v]: any) => [k, v.value]),
    ),
    serviceBindings: Object.fromEntries(
      Object.entries(env)
        .filter(([, v]: any) => v.type === "worker")
        .map(([k, v]: any) => [
          k,
          { name: v.worker, entrypoint: v.exportName },
        ]),
    ),
  });
  const options = {
    workers: [
      worker(
        "caller",
        `export default {async fetch(req,env){return Response.json(await env.CMS.start())}}`,
        { CMS: { type: "worker", worker: "cms", exportName: "Cms" } },
      ),
      worker("cms", compiled.outputFiles[0].text, {
        OLD: { type: "text", value: JSON.stringify(old) },
        SEO: { type: "worker", worker: "seo", exportName: "Seo" },
      }),
      worker(
        "seo",
        `import {WorkerEntrypoint} from 'cloudflare:workers';export class Seo extends WorkerEntrypoint {async claim(){const p=await this.env.CMS.reconsideration({runId:'old',newRunId:'new',articleKey:${JSON.stringify(article)}});return {status:p.status==='eligible'?'claimed':'denied'};}}export default {fetch(){return new Response(null,{status:404})}};`,
        { CMS: { type: "worker", worker: "cms", exportName: "Cms" } },
      ),
    ],
  };
  const convert = (miniflare as any).convertV4MiniflareOptions;
  const mf = new miniflare.Miniflare(convert ? convert(options) : options);
  try {
    expect(await (await mf.dispatchFetch("http://local/")).json()).toEqual({
      response: { status: "claimed" },
      state: "claimed",
    });
  } finally {
    await mf.dispose();
  }
}, 30000);
