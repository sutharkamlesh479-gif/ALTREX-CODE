import { describe, expect, it } from "vitest";
import type { AltrexEvent } from "@altrex/contracts";
import { mergeEvents } from "./state";

// Final audit M5: live events append without re-sorting; replays still deduplicate and order.
const event = (seq: number, streamId = "s1", id = `${streamId}-${seq}`): AltrexEvent =>
  ({ v: 1, streamId, seq, id, ts: new Date(1_000_000 + seq).toISOString(), taskId: "t", type: "agent.message_delta", payload: { text: String(seq) } }) as AltrexEvent;

describe("mergeEvents", () => {
  it("appends newer live events of the same stream in order", () => {
    const previous = [event(1), event(2)];
    const merged = mergeEvents(previous, [event(3), event(4)]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
  it("falls back to dedupe and sort for replays, duplicates and out-of-order batches", () => {
    expect(mergeEvents([event(1), event(3)], [event(2), event(3)]).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(mergeEvents([event(2)], [event(2)])).toHaveLength(1);
    expect(mergeEvents([event(5)], [event(7), event(6)]).map((e) => e.seq)).toEqual([5, 6, 7]);
  });
  it("orders events across streams (history + new process) by time", () => {
    const old = event(9, "old"), fresh = event(1, "new");
    expect(mergeEvents([fresh], [old]).map((e) => e.streamId)).toEqual(["new", "old"]);
  });
});
