import { describe, expect, it } from "vitest";

import {
  calendarCapabilities,
  foregroundColorFor,
  getCalendarTemplate,
  listCalendarTemplates,
  normalizeCalendarColor,
  resolveCalendarCreationDetails,
} from "../src/domain/calendar-management.js";

describe("calendar management domain", () => {
  it("exposes the six predefined templates and defaults to Benny Wang", () => {
    expect(listCalendarTemplates().map((template) => template.name)).toEqual([
      "Benny Wang",
      "Birthdates",
      "Birthdays",
      "Classes",
      "Exams",
      "Tasks",
    ]);
    expect(getCalendarTemplate()).toMatchObject({ id: "benny-wang", name: "Benny Wang" });
    expect(resolveCalendarCreationDetails()).toMatchObject({
      name: "Benny Wang",
      templateId: "benny-wang",
    });
  });

  it("resolves validated template overrides and deterministic foreground colors", () => {
    expect(resolveCalendarCreationDetails({
      color: "#123abc",
      description: "  Class schedule  ",
      name: "  University Classes  ",
      templateId: "classes",
    })).toEqual({
      backgroundColor: "#123ABC",
      description: "Class schedule",
      foregroundColor: "#FFFFFF",
      name: "University Classes",
      templateId: "classes",
    });
    expect(foregroundColorFor("#FFFFFF")).toBe("#000000");
    expect(foregroundColorFor("#000000")).toBe("#FFFFFF");
  });

  it("rejects unknown templates and malformed colors", () => {
    expect(() => getCalendarTemplate("unknown")).toThrow(/Unknown calendar template/);
    expect(() => normalizeCalendarColor("blue")).toThrow(/six-digit hexadecimal/);
    expect(() => resolveCalendarCreationDetails({ name: "   " })).toThrow(/must not be empty/);
  });

  it("fails closed for unknown access roles and protects primary calendars", () => {
    expect(calendarCapabilities("futureRole", false)).toMatchObject({
      accessRole: "unknown",
      canDelete: false,
      canManageEvents: false,
      canManageMetadata: false,
      readOnly: true,
    });
    expect(calendarCapabilities("owner", true)).toMatchObject({
      canDelete: false,
      canManageEvents: true,
      canManageMetadata: true,
      readOnly: false,
    });
    expect(calendarCapabilities("writer", false)).toMatchObject({
      canDelete: false,
      canManageEvents: true,
      canManageMetadata: false,
      readOnly: false,
    });
  });
});
