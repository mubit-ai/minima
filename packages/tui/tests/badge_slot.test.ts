import { describe, expect, test } from "bun:test";
import { getFooterBadge, setFooterBadge, subscribeFooterBadge } from "../src/tui/badge_slot.ts";

describe("footer badge slot (Phase-0 shared surface, MUB-129)", () => {
  test("set → get round-trip and clearing", () => {
    setFooterBadge({ text: "PLAN", color: "yellow" });
    expect(getFooterBadge()).toEqual({ text: "PLAN", color: "yellow" });
    setFooterBadge(null);
    expect(getFooterBadge()).toBeNull();
  });

  test("subscribers fire on change, not on value-equal no-ops", () => {
    let fires = 0;
    const off = subscribeFooterBadge(() => {
      fires += 1;
    });
    setFooterBadge({ text: "🟡 drift" });
    setFooterBadge({ text: "🟡 drift" }); // value-equal → suppressed (useSyncExternalStore friendly)
    expect(fires).toBe(1);
    setFooterBadge({ text: "🟡 drift", color: "yellow" }); // color change is a real change
    expect(fires).toBe(2);
    off();
    setFooterBadge(null);
    expect(fires).toBe(2);
    expect(getFooterBadge()).toBeNull();
  });
});
