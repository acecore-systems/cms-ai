import { handleAdminApiRequest } from "./admin.ts";
import { handleAdminUiRequest } from "./admin-ui.ts";
import type { AppEnv } from "./env.ts";
import { json, toErrorResponse } from "./http.ts";
import { handleRunnerRequest } from "./runner.ts";
import { handleUserRequest } from "./user.ts";

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
