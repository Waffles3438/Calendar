import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config.js";

describe("daily agenda configuration", () => {
  it("defaults to the requested daily delivery and supports an explicit opt-out", () => {
    expect(loadConfig({}).DAILY_AGENDA_ENABLED).toBe(true);
    expect(loadConfig({ DAILY_AGENDA_ENABLED: "false" }).DAILY_AGENDA_ENABLED).toBe(false);
  });

  it("rejects an invalid daily agenda flag", () => {
    expect(() => loadConfig({ DAILY_AGENDA_ENABLED: "sometimes" })).toThrow(ConfigurationError);
  });
});
