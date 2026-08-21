import { describe, expect, it } from "vitest";

import { buildCalendarRRule, expandScheduleDates } from "../src/scheduling/recurrence.js";

describe("scheduling recurrence", () => {
  it("clamps monthly month-end occurrences and yearly leap-day occurrences predictably", () => {
    expect(expandScheduleDates({
      endDate: "2026-04-30",
      recurrence: { frequency: "monthly", interval: 1 },
      startDate: "2026-01-31",
      timeZone: "America/Toronto",
    })).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);

    expect(expandScheduleDates({
      endDate: "2027-03-01",
      recurrence: { frequency: "yearly", interval: 1 },
      startDate: "2024-02-29",
      timeZone: "America/Toronto",
    })).toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28"]);
  });

  it("builds the Calendar recurrence payload with interval and weekday semantics", () => {
    expect(buildCalendarRRule({ frequency: "weekly", interval: 2, weekdays: [3, 5] })).toBe(
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,FR",
    );
    expect(buildCalendarRRule({ frequency: "monthly", interval: 1 })).toBe("RRULE:FREQ=MONTHLY");
  });
});
