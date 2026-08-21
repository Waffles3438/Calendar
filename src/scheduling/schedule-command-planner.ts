import type { ParsedScheduleCommand } from "./schedule-parser.js";

export interface ScheduleCommandPlanningInput {
  readonly now: Date;
  readonly text: string;
  readonly timeZone: string;
}

/** Hosted planning boundary; implementations never receive local/calendar rows or execution tools. */
export interface ScheduleCommandPlanner {
  plan(input: ScheduleCommandPlanningInput): Promise<ParsedScheduleCommand | undefined>;
}
