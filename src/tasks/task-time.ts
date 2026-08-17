import { DateTime, IANAZone } from "luxon";

export const DEFAULT_TASK_TIME_ZONE = "America/Toronto";

export type LocalTaskDateTimeValidation =
  | { readonly kind: "ambiguous" }
  | { readonly kind: "invalid" }
  | { readonly kind: "nonexistent" }
  | { readonly kind: "valid"; readonly value: DateTime };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export function isValidTaskTimeZone(timeZone: string): boolean {
  return timeZone.trim().length > 0 && timeZone.length <= 100 && IANAZone.isValidZone(timeZone);
}

export function isValidTaskDate(date: string, timeZone: string): boolean {
  if (!DATE_PATTERN.test(date) || !isValidTaskTimeZone(timeZone)) {
    return false;
  }

  const parsed = DateTime.fromFormat(date, "yyyy-LL-dd", { setZone: true, zone: timeZone });
  return parsed.isValid && parsed.toFormat("yyyy-LL-dd") === date;
}

/**
 * Validates an explicitly supplied local wall-clock date/time without silently
 * resolving a daylight-saving gap or repeated hour.
 */
export function validateLocalTaskDateTime(
  date: string,
  time: string,
  timeZone: string,
): LocalTaskDateTimeValidation {
  if (!DATE_PATTERN.test(date) || !TIME_PATTERN.test(time) || !isValidTaskTimeZone(timeZone)) {
    return { kind: "invalid" };
  }

  const parsed = DateTime.fromFormat(`${date} ${time}`, "yyyy-LL-dd HH:mm", {
    setZone: true,
    zone: timeZone,
  });
  if (!parsed.isValid) {
    return { kind: "invalid" };
  }
  if (parsed.toFormat("yyyy-LL-dd") !== date || parsed.toFormat("HH:mm") !== time) {
    return { kind: "nonexistent" };
  }

  const possibilities = parsed.getPossibleOffsets();
  if (possibilities.length !== 1) {
    return { kind: "ambiguous" };
  }

  const value = possibilities[0];
  return value ? { kind: "valid", value } : { kind: "invalid" };
}

export function localTaskDate(dueAt: Date, timeZone: string): string {
  return DateTime.fromJSDate(dueAt, { zone: "utc" }).setZone(timeZone).toFormat("yyyy-LL-dd");
}

export function formatTaskDueAt(dueAt: Date, timeZone: string): string {
  const local = DateTime.fromJSDate(dueAt, { zone: "utc" }).setZone(timeZone);
  return `${local.toFormat("ccc, LLL d 'at' h:mm a")} (${timeZone})`;
}
