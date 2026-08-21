import { DateTime } from "luxon";

import type { NaturalLanguageAction } from "./natural-language-action.js";
import type {
  NaturalLanguageCalendarCommand,
  NaturalLanguageDomain,
  NaturalLanguageExample,
  NaturalLanguageTaskCommand,
} from "./natural-language-types.js";

const NOW = "2026-08-17T20:00:00.000Z";
const TIME_ZONE = "America/Toronto";

const promptExamples: readonly NaturalLanguageExample[] = [
  {
    expected: {
      command: { date: "2026-08-18", durationMinutes: 60, kind: "create", startTime: "12:00", title: "lunch with Sam" },
      domain: "calendar",
    },
    id: "calendar-create-prompt-001",
    now: NOW,
    split: "prompt",
    text: "Put lunch with Sam on my calendar tomorrow at noon.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-21", durationMinutes: 45, kind: "create", startTime: "09:30", title: "budget review" },
      domain: "calendar",
    },
    id: "calendar-create-prompt-002",
    now: NOW,
    split: "prompt",
    text: "Block 45 minutes for a budget review on Friday at 9:30am.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-18", kind: "list" },
      domain: "calendar",
    },
    id: "calendar-list-prompt-001",
    now: NOW,
    split: "prompt",
    text: "What is on my calendar tomorrow?",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: {
        kind: "update",
        newStartTime: "16:00",
        selector: { date: "2026-08-18", summary: "dentist appointment", time: "14:00" },
      },
      domain: "calendar",
    },
    id: "calendar-move-prompt-001",
    now: NOW,
    split: "prompt",
    text: "Move my dentist appointment tomorrow at 2pm to 4pm.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: {
        kind: "update",
        newStartTime: "10:00",
        selector: { date: "2026-08-21", summary: "budget review", time: "09:30" },
      },
      domain: "calendar",
    },
    id: "calendar-move-prompt-002",
    now: NOW,
    split: "prompt",
    text: "Push the budget review on Friday from 9:30 to 10.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-18", kind: "create", time: "18:00", title: "run" },
      domain: "task",
    },
    id: "task-create-prompt-001",
    now: NOW,
    split: "prompt",
    text: "Please remember to run tomorrow at six.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-21", kind: "create", time: "12:00", title: "pay hydro" },
      domain: "task",
    },
    id: "task-create-prompt-002",
    now: NOW,
    split: "prompt",
    text: "I need to remember to pay hydro Friday at noon.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-18", kind: "list" },
      domain: "task",
    },
    id: "task-list-prompt-001",
    now: NOW,
    split: "prompt",
    text: "Which local tasks do I have tomorrow?",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { kind: "list" },
      domain: "task",
    },
    id: "task-list-prompt-002",
    now: NOW,
    split: "prompt",
    text: "Show me my to-do list.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { kind: "complete", selector: { title: "pay hydro" } },
      domain: "task",
    },
    id: "task-complete-prompt-001",
    now: NOW,
    split: "prompt",
    text: "Mark pay hydro as done.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { kind: "cancel", selector: { title: "grocery shopping" } },
      domain: "task",
    },
    id: "task-cancel-prompt-001",
    now: NOW,
    split: "prompt",
    text: "I don't need to do the grocery shopping anymore.",
    timeZone: TIME_ZONE,
  },
  {
    expected: { kind: "clarify", reason: "ambiguous_domain" },
    id: "clarify-prompt-001",
    now: NOW,
    split: "prompt",
    text: "Remind me about the dentist.",
    timeZone: TIME_ZONE,
  },
  {
    expected: { kind: "clarify", reason: "missing_required_detail" },
    id: "clarify-prompt-002",
    now: NOW,
    split: "prompt",
    text: "Schedule lunch tomorrow.",
    timeZone: TIME_ZONE,
  },
  {
    expected: { kind: "clarify", reason: "ambiguous_intent" },
    id: "clarify-prompt-003",
    now: NOW,
    split: "prompt",
    text: "Do the usual thing.",
    timeZone: TIME_ZONE,
  },
  {
    expected: { kind: "clarify", reason: "unsupported_intent" },
    id: "clarify-prompt-004",
    now: NOW,
    split: "prompt",
    text: "Make this repeat every week.",
    timeZone: TIME_ZONE,
  },
];

const evaluationExamples: readonly NaturalLanguageExample[] = [
  {
    expected: {
      command: { date: "2026-08-26", durationMinutes: 60, kind: "create", startTime: "14:00", title: "dentist visit" },
      domain: "calendar",
    },
    id: "calendar-create-eval-001",
    now: NOW,
    split: "evaluation",
    text: "Could you put a dentist visit on next Wednesday at 2pm?",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-24", durationMinutes: 90, kind: "create", startTime: "15:00", title: "team planning" },
      domain: "calendar",
    },
    id: "calendar-create-eval-002",
    now: NOW,
    split: "evaluation",
    text: "Add team planning to Monday's calendar from 3pm for 90 minutes.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-24", kind: "list" },
      domain: "calendar",
    },
    id: "calendar-list-eval-001",
    now: NOW,
    split: "evaluation",
    text: "Show me everything I have booked on 2026-08-24.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-21", kind: "list" },
      domain: "calendar",
    },
    id: "calendar-list-eval-002",
    now: NOW,
    split: "evaluation",
    text: "Give me Friday's schedule.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: {
        kind: "update",
        newStartTime: "15:30",
        selector: { date: "2026-08-24", summary: "team planning", time: "15:00" },
      },
      domain: "calendar",
    },
    id: "calendar-move-eval-001",
    now: NOW,
    split: "evaluation",
    text: "Can team planning on Monday start at 3:30 instead of 3?",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: {
        kind: "update",
        newStartTime: "11:00",
        selector: { date: "2026-08-26", summary: "project check-in" },
      },
      domain: "calendar",
    },
    id: "calendar-move-eval-002",
    now: NOW,
    split: "evaluation",
    text: "Reschedule the project check-in next Wednesday to 11am.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-18", kind: "create", time: "07:30", title: "take medication" },
      domain: "task",
    },
    id: "task-create-eval-001",
    now: NOW,
    split: "evaluation",
    text: "Put taking medication on my list for tomorrow morning at 7:30.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-26", kind: "create", time: "19:00", title: "call Mom" },
      domain: "task",
    },
    id: "task-create-eval-002",
    now: NOW,
    split: "evaluation",
    text: "I should call Mom next Wednesday at 7pm; remind me.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { date: "2026-08-21", kind: "list" },
      domain: "task",
    },
    id: "task-list-eval-001",
    now: NOW,
    split: "evaluation",
    text: "Which tasks do I have for Friday?",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { kind: "list" },
      domain: "task",
    },
    id: "task-list-eval-002",
    now: NOW,
    split: "evaluation",
    text: "What is still on my list?",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { kind: "complete", selector: { date: "2026-08-18", title: "call plumber" } },
      domain: "task",
    },
    id: "task-complete-eval-001",
    now: NOW,
    split: "evaluation",
    text: "I'm finished with the plumber call tomorrow.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { kind: "complete", selector: { title: "run" } },
      domain: "task",
    },
    id: "task-complete-eval-002",
    now: NOW,
    split: "evaluation",
    text: "The run task is done.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { kind: "cancel", selector: { date: "2026-08-21", title: "pay hydro" } },
      domain: "task",
    },
    id: "task-cancel-eval-001",
    now: NOW,
    split: "evaluation",
    text: "Cancel the pay hydro item for Friday.",
    timeZone: TIME_ZONE,
  },
  {
    expected: {
      command: { kind: "cancel", selector: { title: "call plumber" } },
      domain: "task",
    },
    id: "task-cancel-eval-002",
    now: NOW,
    split: "evaluation",
    text: "Remove the task about calling the plumber.",
    timeZone: TIME_ZONE,
  },
  {
    expected: { kind: "clarify", reason: "ambiguous_domain" },
    id: "clarify-eval-001",
    now: NOW,
    split: "evaluation",
    text: "Can you remind me about my appointment tomorrow?",
    timeZone: TIME_ZONE,
  },
  {
    expected: { kind: "clarify", reason: "missing_required_detail" },
    id: "clarify-eval-002",
    now: NOW,
    split: "evaluation",
    text: "Put something on my calendar Friday.",
    timeZone: TIME_ZONE,
  },
  {
    expected: { kind: "clarify", reason: "missing_required_detail" },
    id: "clarify-eval-003",
    now: NOW,
    split: "evaluation",
    text: "Remind me to pay the bill tomorrow.",
    timeZone: TIME_ZONE,
  },
  {
    expected: { kind: "clarify", reason: "ambiguous_intent" },
    id: "clarify-eval-004",
    now: NOW,
    split: "evaluation",
    text: "Move it later.",
    timeZone: TIME_ZONE,
  },
  {
    expected: { kind: "clarify", reason: "unsupported_intent" },
    id: "clarify-eval-005",
    now: NOW,
    split: "evaluation",
    text: "Book me a flight for next month.",
    timeZone: TIME_ZONE,
  },
];

export const NATURAL_LANGUAGE_EXAMPLES: readonly NaturalLanguageExample[] = [
  ...promptExamples,
  ...evaluationExamples,
];

export const NATURAL_LANGUAGE_PROMPT_EXAMPLES: readonly NaturalLanguageExample[] = promptExamples;
export const NATURAL_LANGUAGE_EVALUATION_EXAMPLES: readonly NaturalLanguageExample[] = evaluationExamples;

export function examplesForPrompt(domain?: NaturalLanguageDomain): readonly NaturalLanguageExample[] {
  return domain
    ? promptExamples.filter((example) =>
      "domain" in example.expected ? example.expected.domain === domain : true,
    )
    : promptExamples;
}

/** Converts the legacy corpus expectation into the single application action shape. */
export function naturalLanguageExampleToAction(
  example: NaturalLanguageExample,
): NaturalLanguageAction | undefined {
  if (!("domain" in example.expected)) {
    return { action: "ask_clarification", reason: example.expected.reason };
  }

  if (example.expected.domain === "calendar") {
    const command = example.expected.command as NaturalLanguageCalendarCommand;
    switch (command.kind) {
      case "create": {
        const start = DateTime.fromFormat(`${command.date} ${command.startTime}`, "yyyy-LL-dd HH:mm", {
          zone: example.timeZone,
        });
        const end = start.plus({ minutes: command.durationMinutes });
        if (!start.isValid || !end.isValid) {
          return undefined;
        }
        return {
          action: "create_calendar_event",
          date: command.date,
          endDate: end.toFormat("yyyy-LL-dd"),
          endTime: end.toFormat("HH:mm"),
          startTime: command.startTime,
          title: command.title,
        };
      }
      case "list":
        return { action: "list_calendar", date: command.date };
      case "update":
        return command.selector.date
          ? {
            action: "move_calendar_event",
            ...(command.recurrenceScope ? { recurrenceScope: command.recurrenceScope } : {}),
            newStartTime: command.newStartTime,
            selector: {
              date: command.selector.date,
              ...(command.selector.summary ? { summary: command.selector.summary } : {}),
              ...(command.selector.time ? { time: command.selector.time } : {}),
            },
          }
          : undefined;
      case "delete":
        return command.selector.date
          ? {
            action: "delete_calendar_event",
            ...(command.recurrenceScope ? { recurrenceScope: command.recurrenceScope } : {}),
            selector: {
              date: command.selector.date,
              ...(command.selector.summary ? { summary: command.selector.summary } : {}),
              ...(command.selector.time ? { time: command.selector.time } : {}),
            },
          }
          : undefined;
      case "manage_attendees":
        return command.selector.date
          ? {
            action: "manage_calendar_attendees",
            change: { action: command.change.action, emails: [...command.change.emails] },
            ...(command.recurrenceScope ? { recurrenceScope: command.recurrenceScope } : {}),
            selector: {
              date: command.selector.date,
              ...(command.selector.summary ? { summary: command.selector.summary } : {}),
              ...(command.selector.time ? { time: command.selector.time } : {}),
            },
          }
          : undefined;
      case "set_reminder":
        return command.selector.date
          ? {
            action: "set_calendar_reminder",
            minutesBefore: command.minutesBefore,
            selector: {
              date: command.selector.date,
              ...(command.selector.summary ? { summary: command.selector.summary } : {}),
              ...(command.selector.time ? { time: command.selector.time } : {}),
            },
          }
          : undefined;
    }
  }

  const command = example.expected.command as NaturalLanguageTaskCommand;
  switch (command.kind) {
    case "create":
      return {
        action: "create_task_or_reminder",
        date: command.date,
        scheduleKind: "reminder",
        startTime: command.time,
        title: command.title,
      };
    case "list":
      return { action: "list_tasks", ...(command.date ? { date: command.date } : {}) };
    case "complete":
      return { action: "complete_task", selector: command.selector };
    case "cancel":
      return { action: "delete_task", scope: "single", selector: command.selector };
  }
}
