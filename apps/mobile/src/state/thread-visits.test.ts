import { describe, expect, it } from "vite-plus/test";

import { mergeThreadVisits, recordThreadVisit, threadVisitWatermark } from "./thread-visits.logic";

describe("thread visit watermarks", () => {
  it("records only a thread's newest visit", () => {
    const initial = { "environment-1:thread-1": "2026-08-20T07:00:00.000Z" };

    expect(recordThreadVisit(initial, "environment-1:thread-1", "2026-08-20T06:00:00.000Z")).toBe(
      initial,
    );
    expect(
      recordThreadVisit(initial, "environment-1:thread-1", "2026-08-20T08:00:00.000Z"),
    ).toEqual({ "environment-1:thread-1": "2026-08-20T08:00:00.000Z" });
  });

  it("ignores invalid writes", () => {
    const initial = { "environment-1:thread-1": "2026-08-20T07:00:00.000Z" };
    expect(recordThreadVisit(initial, "", "2026-08-20T08:00:00.000Z")).toBe(initial);
    expect(recordThreadVisit(initial, "environment-1:thread-2", "bad-date")).toBe(initial);
  });

  it("merges a visit made during startup without overwriting newer persisted state", () => {
    expect(
      mergeThreadVisits(
        {
          "environment-1:thread-1": "2026-08-20T08:00:00.000Z",
          "environment-1:thread-2": "2026-08-20T06:00:00.000Z",
        },
        {
          "environment-1:thread-1": "2026-08-20T07:00:00.000Z",
          "environment-1:thread-3": "2026-08-20T09:00:00.000Z",
        },
      ),
    ).toEqual({
      "environment-1:thread-1": "2026-08-20T08:00:00.000Z",
      "environment-1:thread-2": "2026-08-20T06:00:00.000Z",
      "environment-1:thread-3": "2026-08-20T09:00:00.000Z",
    });
  });

  it("uses server-authored turn times for visit watermarks", () => {
    expect(
      threadVisitWatermark({
        updatedAt: "2026-08-20T07:00:01.000Z",
        latestTurn: {
          turnId: "turn-running" as never,
          state: "running",
          requestedAt: "2026-08-20T07:00:00.000Z",
          startedAt: "2026-08-20T07:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    ).toBe("2026-08-20T06:59:59.999Z");
    expect(
      threadVisitWatermark({
        updatedAt: "2026-08-20T07:05:00.000Z",
        latestTurn: {
          turnId: "turn-completed" as never,
          state: "completed",
          requestedAt: "2026-08-20T07:00:00.000Z",
          startedAt: "2026-08-20T07:00:01.000Z",
          completedAt: "2026-08-20T07:05:00.000Z",
          assistantMessageId: null,
        },
      }),
    ).toBe("2026-08-20T07:05:00.000Z");
    expect(
      threadVisitWatermark({
        latestTurn: null,
        updatedAt: "2026-08-20T08:00:00.000Z",
      }),
    ).toBe("2026-08-20T08:00:00.000Z");
  });
});
