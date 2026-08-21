import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import type { Logger } from "pino";

import type { ScheduledItem } from "./schedule-domain.js";

export const SCHEDULED_REMINDER_EARLY_MINUTES = 30;
export const SCHEDULED_REMINDER_INTERVAL_MINUTES = 15;
export const SCHEDULED_REMINDER_WINDOW_MINUTES = 120;
export const SCHEDULED_RECURRENCE_MATERIALIZATION_DAYS = 400;
const MINIMUM_CLAIM_LEASE_MILLISECONDS = 5 * 60_000;

export interface ScheduledReminderStateRepository {
  completeScheduledReminderDelivery(input: {
    claimToken: string;
    itemId: string;
    scheduledFor: Date;
    sentAt: Date;
  }): boolean;
  /** Optional for test doubles; the real scheduling repository keeps series rolling. */
  ensureOccurrencesThrough?(input: { now: Date; ownerId: string; throughDate: string }): void;
  listDueScheduledReminders(input: {
    dueAtEarliest: Date;
    dueAtLatest: Date;
    ownerId: string;
  }): readonly ScheduledItem[];
  releaseScheduledReminderClaim(input: {
    claimToken: string;
    itemId: string;
    scheduledFor: Date;
  }): void;
  tryClaimScheduledReminderDelivery(input: {
    claimToken: string;
    itemId: string;
    leaseExpiresAt: Date;
    now: Date;
    ownerId: string;
    scheduledFor: Date;
  }): boolean;
}

export interface ScheduledReminderSchedulerOptions {
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly ownerId: string;
  readonly pollIntervalMilliseconds?: number;
  readonly sendOwnerMessage: (content: string) => Promise<void>;
  readonly stateRepository: ScheduledReminderStateRepository;
}

export interface ScheduledReminderRunResult {
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
}

/** Durable local reminder delivery for the new scheduled-item model. */
export class ScheduledReminderScheduler {
  private readonly claimLeaseMilliseconds: number;
  private readonly now: () => Date;
  private readonly pollIntervalMilliseconds: number;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly options: ScheduledReminderSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 60_000;
    this.claimLeaseMilliseconds = Math.max(MINIMUM_CLAIM_LEASE_MILLISECONDS, this.pollIntervalMilliseconds * 2);
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.pollIntervalMilliseconds);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public async runOnce(): Promise<ScheduledReminderRunResult> {
    if (this.running) {
      return { delivered: 0, failed: 0, skipped: 0 };
    }
    this.running = true;
    try {
      const now = DateTime.fromJSDate(this.now(), { zone: "utc" });
      try {
        this.options.stateRepository.ensureOccurrencesThrough?.({
          now: now.toJSDate(),
          ownerId: this.options.ownerId,
          throughDate: now.plus({ days: SCHEDULED_RECURRENCE_MATERIALIZATION_DAYS }).toFormat("yyyy-LL-dd"),
        });
      } catch (error: unknown) {
        this.options.logger.error({ error }, "Could not materialize recurring scheduled reminders");
        return { delivered: 0, failed: 1, skipped: 0 };
      }

      let reminders: readonly ScheduledItem[];
      try {
        reminders = this.options.stateRepository.listDueScheduledReminders({
          dueAtEarliest: now.minus({ minutes: SCHEDULED_REMINDER_WINDOW_MINUTES }).toJSDate(),
          dueAtLatest: now.plus({ minutes: SCHEDULED_REMINDER_EARLY_MINUTES }).toJSDate(),
          ownerId: this.options.ownerId,
        });
      } catch (error: unknown) {
        this.options.logger.error({ error }, "Could not list scheduled reminders");
        return { delivered: 0, failed: 1, skipped: 0 };
      }
      const total = { delivered: 0, failed: 0, skipped: 0 };
      for (const reminder of reminders) {
        const result = await this.deliverNewestEligibleSlot(reminder, now);
        total.delivered += result.delivered;
        total.failed += result.failed;
        total.skipped += result.skipped;
      }
      return total;
    } finally {
      this.running = false;
    }
  }

  private async deliverNewestEligibleSlot(item: ScheduledItem, now: DateTime): Promise<ScheduledReminderRunResult> {
    if (item.kind !== "reminder" || item.status !== "active" || !item.dueAt) {
      return { delivered: 0, failed: 0, skipped: 1 };
    }
    const due = DateTime.fromJSDate(item.dueAt, { zone: "utc" });
    const slots = [
      due.minus({ minutes: SCHEDULED_REMINDER_EARLY_MINUTES }),
      due,
      ...Array.from(
        { length: SCHEDULED_REMINDER_WINDOW_MINUTES / SCHEDULED_REMINDER_INTERVAL_MINUTES },
        (_, index) => due.plus({ minutes: (index + 1) * SCHEDULED_REMINDER_INTERVAL_MINUTES }),
      ),
    ];
    const eligible = slots.filter((slot) => slot <= now).at(-1);
    if (!eligible || now > due.plus({ minutes: SCHEDULED_REMINDER_WINDOW_MINUTES })) {
      return { delivered: 0, failed: 0, skipped: 1 };
    }
    const scheduledFor = eligible.toJSDate();
    const claimToken = randomUUID();
    try {
      const claimed = this.options.stateRepository.tryClaimScheduledReminderDelivery({
        claimToken,
        itemId: item.id,
        leaseExpiresAt: new Date(now.toMillis() + this.claimLeaseMilliseconds),
        now: now.toJSDate(),
        ownerId: this.options.ownerId,
        scheduledFor,
      });
      if (!claimed) {
        return { delivered: 0, failed: 0, skipped: 1 };
      }
      const phase = eligible < due ? "Upcoming reminder"
        : eligible.equals(due) ? "Reminder"
          : "Late reminder";
      await this.options.sendOwnerMessage(
        `${phase}: ${item.title}. Reply "done ${item.id}" when it is complete.`,
      );
      const recorded = this.options.stateRepository.completeScheduledReminderDelivery({
        claimToken,
        itemId: item.id,
        scheduledFor,
        sentAt: this.now(),
      });
      if (!recorded) {
        this.options.logger.warn({ itemId: item.id }, "Scheduled reminder was sent but its claim was lost");
        return { delivered: 0, failed: 1, skipped: 0 };
      }
      return { delivered: 1, failed: 0, skipped: 0 };
    } catch (error: unknown) {
      try {
        this.options.stateRepository.releaseScheduledReminderClaim({ claimToken, itemId: item.id, scheduledFor });
      } catch (releaseError: unknown) {
        this.options.logger.error({ error: releaseError, itemId: item.id }, "Could not release scheduled reminder claim");
      }
      this.options.logger.error({ error, itemId: item.id }, "Could not send scheduled reminder");
      return { delivered: 0, failed: 1, skipped: 0 };
    }
  }
}
