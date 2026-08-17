export const LOCAL_TASK_STATUSES = ["active", "completed", "cancelled"] as const;

export type LocalTaskStatus = (typeof LOCAL_TASK_STATUSES)[number];
export type LocalTaskOperation = "complete" | "cancel";

/** A locally persisted, owner-private task. Its due instant is always stored in UTC. */
export interface LocalTask {
  readonly cancelledAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt: Date;
  readonly dueAt: Date;
  readonly id: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly status: LocalTaskStatus;
  readonly timeZone: string;
  readonly title: string;
  readonly updatedAt: Date;
}

export interface CreateLocalTaskInput {
  readonly dueAt: Date;
  readonly id: string;
  readonly now: Date;
  readonly ownerId: string;
  readonly timeZone: string;
  readonly title: string;
}

export interface LocalTaskTransitionInput {
  readonly expectedRevision: number;
  readonly id: string;
  readonly now: Date;
  readonly ownerId: string;
}

export interface LocalTaskSelector {
  readonly date?: string;
  readonly title: string;
}
