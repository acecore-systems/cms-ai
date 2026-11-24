import selection from "../config/ai-models.generated.json";
import { HttpError } from "./http.ts";

export function readRegistryMetaSelection(
  feature: "cms.editor" | "seo.editorial",
) {
  const model = selection?.features?.[feature];
  if (
    selection?.schema_version !== 1 ||
    typeof selection.policy_revision !== "string" ||
    !/^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/u.test(selection.policy_revision) ||
    model?.profile !== "text.default" ||
    model.provider !== "meta" ||
    model.execution_mode !== "realtime" ||
    typeof model.api_model_id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model.api_model_id)
  ) {
    throw new HttpError(503, "AIモデルの設定が無効です。");
  }
  return {
    model: model.api_model_id,
    policyRevision: selection.policy_revision,
  };
}

export function getCmsModel(): string {
  return readRegistryMetaSelection("cms.editor").model;
}
