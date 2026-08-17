import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import type { Logger } from "pino";

import type { LocalTask } from "./task-domain.js";
import { formatTaskDueAt } from "./task-time.js";

export const LOCAL_TASK_REMINDER_INTERVAL_MINUTES = 15;
export const LOCAL_TASK_REMINDER_WINDOW_MINUTES = 120;
const MINIMUM_DELIVERY_CLAIM_LEASE_MILLISECONDS = 5 * 60_000;

export interface LocalTaskReminderStateRepository {
  completeLocalTaskReminderDelivery(input: {
    claimToken: string;
    scheduledFor: Date;
    sentAt: Date;
    taskId: string;
  }): boolean;
  listDueLocalTasks(input: {
    dueAtEarliest: Date;
    dueAtLatest: Date;
    ownerId: string;
  }): readonly LocalTask[];
  releaseLocalTaskReminderClaim(input: {
    claimToken: string;
    scheduledFor: Date;
    taskId: string;
  }): void;
  tryClaimLocalTaskReminderDelivery(input: {
    claimToken: string;
    leaseExpiresAt: Date;
    now: Date;
    ownerId: string;
    scheduledFor: Date;
    taskId: string;
  }): boolean;
}

export interface LocalTaskReminderSchedulerOptions {
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly ownerId: string;
  readonly pollIntervalMilliseconds?: number;
  readonly sendOwnerMessage: (content: string) => Promise<void>;
  readonly stateRepository: LocalTaskReminderStateRepository;
}

export interface LocalTaskReminderRunResult {
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Sends durable local task reminders without consulting Google Calendar. A run
 * selects only the newest due reminder slot, preventing burst catch-up after downtime.
 */
export class LocalTaskReminderScheduler {
  private readonly deliveryClaimLeaseMilliseconds: number;
  private readonly now: () => Date;
  private readonly pollIntervalMilliseconds: number;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly options: LocalTaskReminderSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 60_000;
    this.deliveryClaimLeaseMilliseconds = Math.max(
      MINIMUM_DELIVERY_CLAIM_LEASE_MILLISECONDS,
      this.pollIntervalMilliseconds * 2,
    );
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.pollIntervalMilliseconds);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public async runOnce(): Promise<LocalTaskReminderRunResult> {
    if (this.running) {
      return { delivered: 0, failed: 0, skipped: 0 };
    }

    this.running = true;
    try {
      return await this.runScheduledReminders();
    } finally {
      this.running = false;
    }
  }

  private async runScheduledReminders(): Promise<LocalTaskReminderRunResult> {
    const result = { delivered: 0, failed: 0, skipped: 0 };
    const now = DateTime.fromJSDate(this.now(), { zone: "utc" });
    let tasks: readonly LocalTask[];

    try {
      tasks = this.options.stateRepository.listDueLocalTasks({
        dueAtEarliest: now.minus({ minutes: LOCAL_TASK_REMINDER_WINDOW_MINUTES }).toJSDate(),
        dueAtLatest: now.toJSDate(),
        ownerId: this.options.ownerId,
      });
    } catch (error: unknown) {
      this.options.logger.error({ error }, "Could not list local tasks for reminders");
      return { ...result, failed: 1 };
    }

    for (const task of tasks) {
      const delivery = await this.tryDeliverTaskReminder(task, now);
      result.delivered += delivery.delivered;
      result.failed += delivery.failed;
      result.skipped += delivery.skipped;
    }
    return result;
  }

  private async tryDeliverTaskReminder(
    task: LocalTask,
    now: DateTime,
  ): Promise<LocalTaskReminderRunResult> {
    if (task.status !== "active") {
      return { delivered: 0, failed: 0, skipped: 1 };
    }

    const dueAt = DateTime.fromJSDate(task.dueAt, { zone: "utc" });
    const elapsedMilliseconds = now.toMillis() - dueAt.toMillis();
    const windowMilliseconds = LOCAL_TASK_REMINDER_WINDOW_MINUTES * 60_000;
    if (elapsedMilliseconds < 0 || elapsedMilliseconds > windowMilliseconds) {
      return { delivered: 0, failed: 0, skipped: 1 };
    }

    const slotOffsetMinutes = Math.floor(elapsedMilliseconds / (LOCAL_TASK_REMINDER_INTERVAL_MINUTES * 60_000)) *
      LOCAL_TASK_REMINDER_INTERVAL_MINUTES;
    const scheduledFor = dueAt.plus({ minutes: slotOffsetMinutes }).toJSDate();
    const claimToken = randomUUID();
    const nowDate = now.toJSDate();

    try {
      const claimed = this.options.stateRepository.tryClaimLocalTaskReminderDelivery({
        claimToken,
        leaseExpiresAt: new Date(now.toMillis() + this.deliveryClaimLeaseMilliseconds),
        now: nowDate,
        ownerId: this.options.ownerId,
        scheduledFor,
        taskId: task.id,
      });
      if (!claimed) {
        return { delivered: 0, failed: 0, skipped: 1 };
      }

      const delayed = slotOffsetMinutes > 0 || elapsedMilliseconds > 60_000;
      await this.options.sendOwnerMessage(
        `${delayed ? "Late task reminder" : "Task reminder"}: ${task.title} was due ${formatTaskDueAt(task.dueAt, task.timeZone)}. Reply "done ${task.title}" when it is complete.`,
      );
      const recorded = this.options.stateRepository.completeLocalTaskReminderDelivery({
        claimToken,
        scheduledFor,
        sentAt: new Date(),
        taskId: task.id,
      });
      if (!recorded) {
        this.options.logger.warn({ taskId: task.id }, "Local task reminder was sent but its delivery claim was lost");
        return { delivered: 0, failed: 1, skipped: 0 };
      }
      return { delivered: 1, failed: 0, skipped: 0 };
    } catch (error: unknown) {
      try {
        this.options.stateRepository.releaseLocalTaskReminderClaim({ claimToken, scheduledFor, taskId: task.id });
      } catch (releaseError: unknown) {
        this.options.logger.error({ error: releaseError, taskId: task.id }, "Could not release local task reminder claim");
      }
      this.options.logger.error({ error, taskId: task.id }, "Could not deliver local task reminder");
      return { delivered: 0, failed: 1, skipped: 0 };
    }
  }
}
