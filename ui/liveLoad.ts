// Live Load: while a block is on screen in a visible page, the files it reads
// with Load are read again every 2 s, so a card over a file another process
// rewrites (a waitlist, a burndown) stays current. Hidden, it does not poll.
import type { LoadedData } from "../core";

export const LIVE_LOAD_MS = 2000;

export interface LiveClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: LiveClock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface LiveLoadOptions {
  readonly paths: readonly string[];
  readonly read: (path: string) => Promise<LoadedData>;
  /** Called with a path's new result; an unchanged re-read is not reported. */
  readonly onData: (path: string, loaded: LoadedData) => void;
  /** The card's evidence files; when given, any other path is refused and never read. */
  readonly evidence?: readonly string[];
  readonly clock?: LiveClock;
}

export function liveLoad({ paths, read, onData, evidence, clock = REAL_CLOCK }: LiveLoadOptions): {
  setVisible(visible: boolean): void;
  stop(): void;
} {
  const known = evidence === undefined ? paths : paths.filter((path) => evidence.includes(path));
  for (const path of paths)
    if (!known.includes(path)) onData(path, { ok: false, error: `card.evidence_unknown: ${path} is not one of the card's evidence files` });
  const last = new Map<string, string>();
  let timer: unknown = null;
  let visible = false;
  let stopped = false;
  let reading = false;

  const schedule = () => {
    if (visible && !stopped && !reading && timer === null && known.length > 0) timer = clock.setTimeout(tick, LIVE_LOAD_MS);
  };
  const tick = async () => {
    timer = null;
    reading = true; // the next read waits for this one, so slow reads never pile up
    await Promise.all(
      known.map((path) =>
        read(path).then(
          (loaded) => {
            const signature = JSON.stringify(loaded);
            if (stopped || last.get(path) === signature) return;
            last.set(path, signature);
            onData(path, loaded);
          },
          // A failed re-read keeps what is shown; the next tick tries again.
          () => undefined,
        ),
      ),
    );
    reading = false;
    schedule();
  };

  return {
    setVisible(next) {
      visible = next;
      if (!visible && timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
