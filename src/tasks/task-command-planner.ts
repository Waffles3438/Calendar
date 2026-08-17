import type { ParsedTaskCommand } from "./deterministic-task-parser.js";

/** The only data a local-task NLP fallback may receive from the task assistant. */
export interface TaskCommandPlanningInput {
  readonly now: Date;
  readonly text: string;
  readonly timeZone: string;
}

/**
 * Interprets an owner request into a locally validated task command. It has no
 * authority to read task rows, persist data, or send Discord messages.
 */
export interface TaskCommandPlanner {
  plan(input: TaskCommandPlanningInput): Promise<ParsedTaskCommand | undefined>;
}
