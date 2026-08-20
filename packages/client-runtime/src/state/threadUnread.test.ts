import { describe, expect, it } from "vite-plus/test";

import { hasUnseenCompletion } from "./threadUnread.ts";

const completedTurn = {
  completedAt: "2026-08-20T07:00:00.000Z",
  state: "completed" as const,
};

describe("hasUnseenCompletion", () => {
  it("reports a completion newer than the device visit", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: completedTurn,
        lastVisitedAt: "2026-08-20T06:59:59.000Z",
      }),
    ).toBe(true);
  });

  it("treats the completion as read once the visit catches up", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: completedTurn,
        lastVisitedAt: completedTurn.completedAt,
      }),
    ).toBe(false);
  });

  it("does not light up old threads when a device has no visit watermark", () => {
    expect(hasUnseenCompletion({ latestTurn: completedTurn, lastVisitedAt: null })).toBe(false);
  });

  it("does not report malformed or unfinished turns", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: { completedAt: "not-a-date", state: "completed" },
        lastVisitedAt: "bad",
      }),
    ).toBe(false);
    expect(hasUnseenCompletion({ latestTurn: null, lastVisitedAt: "bad" })).toBe(false);
  });

  it("does not report an interrupted turn as completed", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: { ...completedTurn, state: "interrupted" },
        lastVisitedAt: "2026-08-20T06:59:59.000Z",
      }),
    ).toBe(false);
  });
});
