import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectLoads, compile, parseDataFile, type LoadedData } from "../core";
import { LIVE_LOAD_MS, liveLoad, type LiveClock } from "./liveLoad";

/** A clock the test moves by hand: timers fire only inside `advance`. */
function fakeClock(): LiveClock & { advance(ms: number): Promise<void>; pending(): number } {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    setTimeout(fn, ms) {
      timers.set(++next, { at: now + ms, fn });
      return next;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

// Joseph forbids the system temp folder: the temporary file goes only under GENUI_TEST_TMP.
const SCRATCH = process.env.GENUI_TEST_TMP;
if (!SCRATCH) throw new Error("GENUI_TEST_TMP is unset: point it at a scratch folder (never the system temp folder)");

describe("live Load", () => {
  let dir: string;
  let file: string;
  let reads: number;
  let clock: ReturnType<typeof fakeClock>;
  let seen: { path: string; loaded: LoadedData }[];

  const read = async (path: string): Promise<LoadedData> => {
    reads++;
    return parseDataFile(path, readFileSync(join(dir, path), "utf8"));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(SCRATCH, "live-load-"));
    file = join(dir, "burndown.json");
    writeFileSync(file, JSON.stringify({ open: 3 }));
    reads = 0;
    clock = fakeClock();
    seen = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The fixture card: a Card that reads its file with Load.
  const card = compile('Card("Burndown", [Text(fmt(Load("burndown.json").open))])');
  const paths = () => collectLoads(card.program!).map((request) => request.path);

  it("re-reads every 2 s while visible, stops while hidden and resumes when shown", async () => {
    expect(card.program).not.toBeNull();
    const live = liveLoad({ paths: paths(), read, onData: (path, loaded) => seen.push({ path, loaded }), clock });

    await clock.advance(10 * LIVE_LOAD_MS);
    expect(reads).toBe(0); // never shown: no polling

    live.setVisible(true);
    await clock.advance(LIVE_LOAD_MS - 1);
    expect(reads).toBe(0);
    await clock.advance(1);
    expect(reads).toBe(1);
    writeFileSync(file, JSON.stringify({ open: 2 }));
    await clock.advance(LIVE_LOAD_MS);
    expect(reads).toBe(2);
    expect(seen.at(-1)).toEqual({ path: "burndown.json", loaded: { ok: true, value: { open: 2 } } });

    live.setVisible(false);
    writeFileSync(file, JSON.stringify({ open: 1 }));
    await clock.advance(10 * LIVE_LOAD_MS);
    expect(reads).toBe(2);
    expect(clock.pending()).toBe(0);

    live.setVisible(true);
    await clock.advance(LIVE_LOAD_MS);
    expect(reads).toBe(3);
    expect(seen.at(-1)?.loaded).toEqual({ ok: true, value: { open: 1 } });

    live.stop();
    await clock.advance(10 * LIVE_LOAD_MS);
    expect(reads).toBe(3);
  });

  it("refuses a Load that is not one of the card's evidence with card.evidence_unknown, and never reads it", async () => {
    const live = liveLoad({ paths: [...paths(), "secret.json"], evidence: ["burndown.json"], read, onData: (path, loaded) => seen.push({ path, loaded }), clock });
    live.setVisible(true);
    await clock.advance(LIVE_LOAD_MS);
    expect(reads).toBe(1);
    const refused = seen.find((entry) => entry.path === "secret.json");
    expect(refused?.loaded.ok).toBe(false);
    expect(refused?.loaded.ok === false && refused.loaded.error).toMatch(/^card\.evidence_unknown: /);
    live.stop();
  });
});
