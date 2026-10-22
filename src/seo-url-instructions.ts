import { LEARN_VIEW_URL_INSTRUCTION } from "./seo-evidence.ts";

export function referenceInstructions(version = 1): string {
  if (version === 1) return LEARN_VIEW_URL_INSTRUCTION;
  if (version !== 2) throw new Error("seo_url_instructions");
  return "URL policy2 retains ordinary public HTTPS URLs WITHOUT query strings on any safe public host; it is NOT a Microsoft Learn-only host allowlist. For example, a new official help.minecraft.net article without a query is eligible when it meets all evidence rules. Microsoft Learn restrictions apply ONLY to the additional query-bearing exception: exact https://learn.microsoft.com/en-us/minecraft/creator/documents/<lowercase alphanumeric-or-hyphen path segments>?view=minecraft-bedrock-stable. Reject every other query, duplicate key, fragment, credentials and port; encoded bypasses are not allowed. Preserve the exact search-source URL without rewriting. Safe URL syntax is not proof of official status, relevance or support. Existing URLs and source-site URLs remain excluded; all fixed factual conditions must still be supported by retrieved primary evidence.";
}
