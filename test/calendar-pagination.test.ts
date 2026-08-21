import { describe, expect, it } from "vitest";

import { collectGooglePages, GoogleCalendarConnectionError } from "../src/google/calendar-api.js";

describe("Google Calendar pagination", () => {
  it("collects every page in order and forwards each prior token", async () => {
    const tokens: Array<string | undefined> = [];
    const values = await collectGooglePages(async (pageToken) => {
      tokens.push(pageToken);
      if (!pageToken) {
        return { items: ["first"], nextPageToken: "page-2" };
      }
      if (pageToken === "page-2") {
        return { items: ["second"], nextPageToken: "page-3" };
      }
      return { items: ["third"] };
    });
    expect(values).toEqual(["first", "second", "third"]);
    expect(tokens).toEqual([undefined, "page-2", "page-3"]);
  });

  it("fails closed instead of looping or returning a partial collection for a repeated token", async () => {
    await expect(collectGooglePages(async () => ({ items: ["one"], nextPageToken: "repeat" }))).rejects.toThrow(
      GoogleCalendarConnectionError,
    );
  });
});
