import type { ThreadLastVisitedAtByKey } from "../persistence/imperative";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export function threadVisitWatermark(
  thread: Pick<EnvironmentThreadShell, "latestTurn" | "updatedAt">,
): string | null {
  const turn = thread.latestTurn;
  if (turn === null) return thread.updatedAt;
  if (turn.state !== "running") return turn.completedAt;

  const requestedAt = Date.parse(turn.requestedAt);
  return Number.isFinite(requestedAt) ? new Date(requestedAt - 1).toISOString() : null;
}

export function recordThreadVisit(
  visits: ThreadLastVisitedAtByKey,
  threadKey: string,
  visitedAt: string,
): ThreadLastVisitedAtByKey {
  const visitedAtMs = Date.parse(visitedAt);
  if (!threadKey || !Number.isFinite(visitedAtMs)) return visits;

  const previousVisitedAt = visits[threadKey];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (Number.isFinite(previousVisitedAtMs) && previousVisitedAtMs >= visitedAtMs) return visits;
  return { ...visits, [threadKey]: visitedAt };
}

export function mergeThreadVisits(
  persisted: ThreadLastVisitedAtByKey,
  current: ThreadLastVisitedAtByKey,
): ThreadLastVisitedAtByKey {
  let merged = persisted;
  for (const [threadKey, visitedAt] of Object.entries(current)) {
    merged = recordThreadVisit(merged, threadKey, visitedAt);
  }
  return merged;
}
