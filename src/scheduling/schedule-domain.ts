export const SCHEDULE_KINDS = ["task", "reminder"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const SCHEDULE_STATUSES = ["active", "completed", "cancelled"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** A recurrence is always anchored to the series start date. */
export interface ScheduleRecurrence {
  readonly frequency: RecurrenceFrequency;
  readonly interval: number;
  /** ISO weekdays 1 (Monday) through 7 (Sunday), valid only for weekly series. */
  readonly weekdays?: readonly number[];
}

export interface ScheduledItem {
  readonly cancelledAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt: Date;
  /** A UTC instant for a timed reminder; absent for an all-day task. */
  readonly dueAt?: Date;
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly occurrenceKey?: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly scheduledDate: string;
  readonly seriesId?: string;
  readonly status: ScheduleStatus;
  readonly timeZone: string;
  readonly title: string;
  readonly updatedAt: Date;
}

export interface ScheduleSeries {
  readonly cancelledAt?: Date;
  readonly createdAt: Date;
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly ownerId: string;
  readonly recurrence: ScheduleRecurrence;
  readonly startDate: string;
  readonly startTime?: string;
  readonly status: "active" | "cancelled";
  readonly timeZone: string;
  readonly title: string;
  readonly updatedAt: Date;
}

export interface CreateScheduledItemInput {
  readonly dueAt?: Date;
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly now: Date;
  readonly occurrenceKey?: string;
  readonly ownerId: string;
  readonly scheduledDate: string;
  readonly seriesId?: string;
  readonly timeZone: string;
  readonly title: string;
}

export interface CreateScheduleSeriesInput {
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly now: Date;
  readonly ownerId: string;
  readonly recurrence: ScheduleRecurrence;
  readonly startDate: string;
  readonly startTime?: string;
  readonly timeZone: string;
  readonly title: string;
}

export interface ScheduledItemTransitionInput {
  readonly expectedRevision: number;
  readonly id: string;
  readonly now: Date;
  readonly ownerId: string;
}

export interface ScheduledItemCancellationTarget {
  readonly expectedRevision: number;
  readonly id: string;
}

export const MAX_BULK_SCHEDULE_CANCELLATIONS = 1_000;
