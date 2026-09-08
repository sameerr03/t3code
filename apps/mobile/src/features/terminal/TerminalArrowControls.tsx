import { useLayoutEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";

import { ComposerToolbarButton } from "../../components/ComposerToolbar";
import { createTerminalKeyRepeat } from "./terminalKeyRepeat";

const ARROWS = [
  { label: "←", name: "Left arrow", data: "\u001b[D" },
  { label: "↓", name: "Down arrow", data: "\u001b[B" },
  { label: "↑", name: "Up arrow", data: "\u001b[A" },
  { label: "→", name: "Right arrow", data: "\u001b[C" },
] as const;

function TerminalArrowButton(props: {
  readonly label: string;
  readonly name: string;
  readonly data: string;
  readonly disabled: boolean;
  readonly onInput: (data: string) => Promise<boolean>;
}) {
  const [repeat] = useState(createTerminalKeyRepeat);
  const input = useRef(props.onInput);
  const touchStarted = useRef(false);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    input.current = props.onInput;
  }, [props.onInput]);

  useLayoutEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        repeat.stop();
        clearTimeout(releaseTimer.current);
        touchStarted.current = false;
      }
    });
    if (props.disabled) repeat.stop();
    return () => {
      repeat.stop();
      clearTimeout(releaseTimer.current);
      touchStarted.current = false;
      subscription.remove();
    };
  }, [props.disabled, repeat]);

  return (
    <ComposerToolbarButton
      accessibilityLabel={props.name}
      disabled={props.disabled}
      label={props.label}
      minWidth={44}
      maxWidth={44}
      className="shrink-0 px-0"
      onPressIn={() => {
        clearTimeout(releaseTimer.current);
        touchStarted.current = true;
        repeat.start(() => input.current(props.data));
      }}
      onPressOut={() => {
        repeat.stop();
        // Pressability calls onPress after onPressOut for a successful touch.
        // A canceled touch has no onPress, so clear its marker next tick too.
        releaseTimer.current = setTimeout(() => {
          touchStarted.current = false;
        }, 0);
      }}
      onPress={() => {
        // Screen-reader activation can arrive without the touch press lifecycle.
        if (!touchStarted.current) void input.current(props.data);
        touchStarted.current = false;
      }}
      showChevron={false}
    />
  );
}

export function TerminalArrowControls(props: {
  readonly disabled: boolean;
  readonly onInput: (data: string) => Promise<boolean>;
}) {
  return (
    <View className="shrink-0 flex-row gap-1">
      {ARROWS.map((arrow) => (
        <TerminalArrowButton key={arrow.name} {...arrow} {...props} />
      ))}
    </View>
  );
}
