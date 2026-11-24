import selection from "../config/ai-models.generated.json";
import { HttpError } from "./http.ts";

export function getCmsModel(): string {
  const model = selection?.features?.["cms.editor"];
  if (
    selection?.schema_version !== 1 ||
    typeof selection.policy_revision !== "string" ||
    !selection.policy_revision.trim() ||
    model?.profile !== "text.default" ||
    model.provider !== "meta" ||
    model.execution_mode !== "realtime" ||
    typeof model.api_model_id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model.api_model_id)
  ) {
    throw new HttpError(503, "AIモデルの設定が無効です。");
  }
  return model.api_model_id;
}
