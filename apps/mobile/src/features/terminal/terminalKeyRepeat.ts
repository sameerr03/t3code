/** Repeats a held key without queuing writes behind a slow connection. */
export function createTerminalKeyRepeat() {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
  };

  return {
    stop,
    start(write: () => Promise<boolean>) {
      stop();
      const current = generation;
      const send = async (delay: number) => {
        if (current !== generation) return;
        try {
          if (!(await write()) || current !== generation) return;
          timer = setTimeout(() => void send(80), delay);
        } catch {
          // A failed write ends this hold; the terminal owns connection errors.
        }
      };
      void send(400);
    },
  };
}
