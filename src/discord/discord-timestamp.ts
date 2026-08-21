import { DateTime, IANAZone } from "luxon";

export type DiscordTimestampStyle = "D" | "F";

/** Lets Discord render a specific instant in each recipient's locale and time zone. */
export function formatDiscordTimestamp(value: Date, style: DiscordTimestampStyle = "F"): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new Error("Discord timestamps require a valid Date");
  }
  return `<t:${Math.floor(value.valueOf() / 1_000)}:${style}>`;
}

/**
 * Represents a date-only value at local noon to avoid treating an all-day item
 * as midnight in the configured zone. Discord still renders the date locally.
 */
export function formatDiscordDate(localDate: string, timeZone: string): string {
  if (!IANAZone.isValidZone(timeZone)) {
    throw new Error("Discord date timestamps require a valid IANA time zone");
  }
  const date = DateTime.fromFormat(localDate, "yyyy-LL-dd", { setZone: true, zone: timeZone }).set({ hour: 12 });
  if (!date.isValid || date.toFormat("yyyy-LL-dd") !== localDate) {
    throw new Error("Discord date timestamps require a valid local ISO date");
  }
  return formatDiscordTimestamp(date.toUTC().toJSDate(), "D");
}
