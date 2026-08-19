import type { ComposerContextPicker } from "../../composer-logic";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

type BuiltInSlashCommandItem = Extract<ComposerCommandItem, { type: "slash-command" }>;

const CONTEXT_PICKER_COMMANDS = [
  {
    command: "environment",
    description: "Choose which environment runs this thread",
  },
  {
    command: "worktree",
    description: "Choose the local checkout or a worktree",
  },
  {
    command: "branch",
    description: "Choose the branch for this thread",
  },
] as const satisfies ReadonlyArray<{
  command: ComposerContextPicker;
  description: string;
}>;

export function getBuiltInSlashCommandItems(input: {
  readonly planModeUiEnabled: boolean;
  readonly contextPickerAvailability: Readonly<Record<ComposerContextPicker, boolean>>;
}): BuiltInSlashCommandItem[] {
  return [
    {
      id: "slash:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch response model for this thread",
    },
    ...CONTEXT_PICKER_COMMANDS.filter(
      ({ command }) => input.contextPickerAvailability[command],
    ).map(({ command, description }) => ({
      id: `slash:${command}`,
      type: "slash-command" as const,
      command,
      label: `/${command}`,
      description,
    })),
    ...(input.planModeUiEnabled
      ? [
          {
            id: "slash:plan",
            type: "slash-command" as const,
            command: "plan" as const,
            label: "/plan",
            description: "Switch this thread into plan mode",
          },
          {
            id: "slash:default",
            type: "slash-command" as const,
            command: "default" as const,
            label: "/default",
            description: "Switch this thread back to normal build mode",
          },
        ]
      : []),
  ];
}
