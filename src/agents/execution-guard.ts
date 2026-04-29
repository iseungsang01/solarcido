export function goalLikelyRequiresModification(goal: string): boolean {
  const normalized = goal.toLowerCase();
  return [
    "add",
    "change",
    "create",
    "edit",
    "fix",
    "implement",
    "modify",
    "refactor",
    "remove",
    "rename",
    "replace",
    "update",
    "write",
    "고쳐",
    "구현",
    "만들",
    "바꿔",
    "변경",
    "수정",
    "업데이트",
    "작성",
    "추가",
  ].some((keyword) => normalized.includes(keyword));
}

export function isSuccessfulModificationTool(toolName: string, content: string): boolean {
  if (content.startsWith("ERROR:")) return false;
  return toolName === "edit_file" || toolName === "write_file";
}

export function blockedPrematureFinishMessage(): string {
  return "ERROR: This goal appears to require code or documentation changes, but no edit_file or write_file call has succeeded yet. Inspect the repository, make the required edits, run relevant verification, then call finish.";
}

