export function agentTestMode(body) {
  return String(body?.testMode || "") === "true";
}

export function cliToolArgs(testMode, allowedTools) {
  if (testMode) return ["--allowedTools", "", "--tools", ""];
  return ["--allowedTools", allowedTools];
}
