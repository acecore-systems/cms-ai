import type { Job } from "./models.ts";

const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARACTERS = 24_000;

// Intent classification and generation must use the same authorized history.
export function selectConversationJobs(
  currentJob: Job,
  conversationJobs: Job[],
) {
  const previousJobs = conversationJobs
    .filter(
      (job) =>
        job.conversationId === currentJob.conversationId &&
        job.siteId === currentJob.siteId &&
        job.requestedBy === currentJob.requestedBy &&
        job.turnNumber < currentJob.turnNumber,
    )
    .sort((left, right) => left.turnNumber - right.turnNumber)
    .slice(-MAX_HISTORY_TURNS);
  const selected: Job[] = [];
  let characters = 0;

  for (const job of previousJobs.reverse()) {
    const turnCharacters =
      job.instruction.length + buildPreviousAssistantMessage(job).length;
    if (
      selected.length > 0 &&
      characters + turnCharacters > MAX_HISTORY_CHARACTERS
    ) {
      break;
    }
    selected.unshift(job);
    characters += turnCharacters;
  }

  return selected;
}

export function buildPreviousAssistantMessage(job: Job) {
  const message =
    (job.status === "failed" ? job.errorMessage : null) ||
    job.assistantMessage ||
    job.clarification ||
    job.summary ||
    job.errorMessage ||
    "前回の処理結果はありません。";
  const changedPaths = job.changedPaths.length
    ? "\n変更ファイル: " + job.changedPaths.join(", ")
    : "";
  return message + changedPaths;
}
