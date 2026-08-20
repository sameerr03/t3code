import type { OrchestrationLatestTurn } from "@t3tools/contracts";

export function hasUnseenCompletion(input: {
  readonly latestTurn: Pick<OrchestrationLatestTurn, "completedAt" | "state"> | null;
  readonly lastVisitedAt: string | null | undefined;
}): boolean {
  if (input.latestTurn?.state !== "completed" || !input.latestTurn.completedAt) return false;
  const completedAt = Date.parse(input.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!input.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(input.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}
