import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createTerminalKeyRepeat } from "./terminalKeyRepeat";

describe("terminal key repeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a tap immediately and does not repeat after release", async () => {
    const repeat = createTerminalKeyRepeat();
    const write = vi.fn(async () => true);
    repeat.start(write);
    expect(write).toHaveBeenCalledTimes(1);
    repeat.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("repeats after the hold delay and stops on cancellation", async () => {
    const repeat = createTerminalKeyRepeat();
    const write = vi.fn(async () => true);
    repeat.start(write);
    await vi.advanceTimersByTimeAsync(399);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(160);
    expect(write).toHaveBeenCalledTimes(4);
    repeat.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(4);
  });

  it("does not queue repeats while a remote write is pending or resume a released hold", async () => {
    const pending = Promise.withResolvers<boolean>();
    const write = vi.fn(() => pending.promise);
    const repeat = createTerminalKeyRepeat();
    repeat.start(write);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(write).toHaveBeenCalledTimes(1);
    repeat.stop();
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never resumes an old hold when another key has started", async () => {
    const pending = Promise.withResolvers<boolean>();
    const oldWrite = vi.fn(() => pending.promise);
    const newWrite = vi.fn(async () => true);
    const repeat = createTerminalKeyRepeat();
    repeat.start(oldWrite);
    repeat.start(newWrite);
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(oldWrite).toHaveBeenCalledTimes(1);
    expect(newWrite).toHaveBeenCalledTimes(2);
    repeat.stop();
  });

  it.each([false, new Error("Disconnected")])(
    "ends a hold after a failed write: %s",
    async (result) => {
      const repeat = createTerminalKeyRepeat();
      const write = vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      });
      repeat.start(write);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(write).toHaveBeenCalledTimes(1);
    },
  );
});
