import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import type { Logger } from "pino";

import type { AgendaService } from "./agenda-service.js";

const DAILY_AGENDA_HOUR = 7;
const CLAIM_LEASE_MILLISECONDS = 10 * 60_000;

export interface DailyAgendaStateRepository {
  completeDailyAgenda(input: { claimToken: string; localDate: string; ownerId: string; sentAt: Date }): boolean;
  releaseDailyAgendaClaim(input: { claimToken: string; localDate: string; ownerId: string }): void;
  tryClaimDailyAgenda(input: {
    claimToken: string;
    leaseExpiresAt: Date;
    localDate: string;
    now: Date;
    ownerId: string;
  }): boolean;
}

export interface DailyAgendaSchedulerOptions {
  readonly agendaService: Pick<AgendaService, "render">;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly ownerId: string;
  readonly pollIntervalMilliseconds?: number;
  readonly sendOwnerMessage: (content: string) => Promise<void>;
  readonly stateRepository: DailyAgendaStateRepository;
  readonly timeZone: string;
}

export interface DailyAgendaRunResult {
  readonly delivered: boolean;
  readonly failed: boolean;
  readonly skipped: boolean;
}

/** Sends one owner-only agenda after 7:00 AM local time with durable delivery claims. */
export class DailyAgendaScheduler {
  private readonly now: () => Date;
  private readonly pollIntervalMilliseconds: number;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly options: DailyAgendaSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 60_000;
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

  public async runOnce(): Promise<DailyAgendaRunResult> {
    if (this.running) {
      return { delivered: false, failed: false, skipped: true };
    }
    this.running = true;
    let claimed = false;
    let claimToken: string | undefined;
    let localDate: string | undefined;
    try {
      const now = this.now();
      const local = DateTime.fromJSDate(now, { zone: this.options.timeZone });
      if (!local.isValid || local.hour < DAILY_AGENDA_HOUR) {
        return { delivered: false, failed: false, skipped: true };
      }
      localDate = local.toFormat("yyyy-LL-dd");
      claimToken = randomUUID();
      claimed = this.options.stateRepository.tryClaimDailyAgenda({
        claimToken,
        leaseExpiresAt: new Date(now.valueOf() + CLAIM_LEASE_MILLISECONDS),
        localDate,
        now,
        ownerId: this.options.ownerId,
      });
      if (!claimed) {
        return { delivered: false, failed: false, skipped: true };
      }

      const content = await this.options.agendaService.render({ date: localDate, endDate: localDate, range: "day" });
      await this.options.sendOwnerMessage(content);
      const recorded = this.options.stateRepository.completeDailyAgenda({
        claimToken,
        localDate,
        ownerId: this.options.ownerId,
        sentAt: this.now(),
      });
      if (!recorded) {
        this.options.logger.warn({ localDate }, "Daily agenda was sent but its delivery claim was lost");
        return { delivered: false, failed: true, skipped: false };
      }
      return { delivered: true, failed: false, skipped: false };
    } catch (error: unknown) {
      if (claimed && claimToken && localDate) {
        try {
          this.options.stateRepository.releaseDailyAgendaClaim({ claimToken, localDate, ownerId: this.options.ownerId });
        } catch (releaseError: unknown) {
          this.options.logger.error({ error: releaseError, localDate }, "Could not release daily agenda claim");
        }
      }
      this.options.logger.error({ error, localDate }, "Could not deliver daily agenda");
      return { delivered: false, failed: true, skipped: false };
    } finally {
      this.running = false;
    }
  }
}
