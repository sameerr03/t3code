import { describe, expect, it } from "vite-plus/test";

import { getBuiltInSlashCommandItems } from "./composerBuiltInCommands";

describe("getBuiltInSlashCommandItems", () => {
  it("includes each available context picker", () => {
    const commands = getBuiltInSlashCommandItems({
      planModeUiEnabled: false,
      contextPickerAvailability: {
        environment: true,
        worktree: true,
        branch: true,
      },
    });

    expect(commands.map((command) => command.command)).toEqual([
      "model",
      "environment",
      "worktree",
      "branch",
    ]);
  });

  it("omits pickers that cannot open in the current thread", () => {
    const commands = getBuiltInSlashCommandItems({
      planModeUiEnabled: true,
      contextPickerAvailability: {
        environment: false,
        worktree: false,
        branch: true,
      },
    });

    expect(commands.map((command) => command.command)).toEqual([
      "model",
      "branch",
      "plan",
      "default",
    ]);
  });
});
