import { handleAdminApiRequest } from "./admin.ts";
import { handleAdminUiRequest } from "./admin-ui.ts";
import type { AppEnv } from "./env.ts";
import { json, toErrorResponse } from "./http.ts";
import { handleRunnerRequest } from "./runner.ts";
import { handleUserRequest } from "./user.ts";
import { handleSeoRunnerRequest } from "./seo-editorial.ts";

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    try {
      if (pathname === "/health") {
        return json({ ok: true, service: "cms-ai" });
      }

      if (pathname.startsWith("/runner/")) {
        return await handleRunnerRequest(request, env);
      }

      if (pathname.startsWith("/seo-runner/")) {
        // Historical jobs remain readable and can be marked unresolved, but a
        // rollback flag must not resume the retired Luna paid-call path.
        if (
          env.SEO_SEARCH_PROVIDER !== "parallel-free" &&
          request.method !== "GET" &&
          !pathname.endsWith("/unresolved")
        )
          return json(
            { status: "retired", reason: "seo_legacy_model_retired" },
            409,
          );
        return await handleSeoRunnerRequest(request, env);
      }

      if (pathname.startsWith("/admin/api/ai/")) {
        return await handleUserRequest(request, env);
      }

      if (pathname.startsWith("/admin/api/")) {
        return await handleAdminApiRequest(request, env);
      }

      if (
        pathname === "/" &&
        new URL(request.url).hostname === "cms-ai.acecore.net"
      ) {
        return new Response(null, {
          headers: { "Cache-Control": "no-store", Location: "/admin/" },
          status: 302,
        });
      }

      if (pathname === "/admin" || pathname.startsWith("/admin/")) {
        return await handleAdminUiRequest(request, env);
      }

      return json({ message: "Not found" }, 404);
    } catch (error) {
      return toErrorResponse(error, "cms_ai_request_failed");
    }
  },
} satisfies ExportedHandler<AppEnv>;

export { SeoConnection, SeoGeneration, SeoEditorial } from "./seo.ts";
