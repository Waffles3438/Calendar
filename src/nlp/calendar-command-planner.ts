import type { ParsedCalendarCommand } from "./deterministic-command-parser.js";

/** The only data an NLP fallback may receive from the calendar assistant. */
export interface CalendarCommandPlanningInput {
  readonly now: Date;
  readonly text: string;
  readonly timeZone: string;
}

/**
 * Interprets a user message into a locally validated command without any
 * authority to read, persist, or execute calendar data.
 */
export interface CalendarCommandPlanner {
  plan(input: CalendarCommandPlanningInput): Promise<ParsedCalendarCommand | undefined>;
}
