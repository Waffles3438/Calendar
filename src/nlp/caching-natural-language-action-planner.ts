import { createHash } from "node:crypto";
import { DateTime, IANAZone } from "luxon";

import {
  validateNaturalLanguageAction,
  type NaturalLanguageAction,
  type NaturalLanguageActionPlanningInput,
} from "./natural-language-action.js";
import type { NaturalLanguageActionPlanner } from "./natural-language-action-planner.js";

export const NATURAL_LANGUAGE_ACTION_CACHE_VERSION = "1";
export const NATURAL_LANGUAGE_ACTION_CACHE_TTL_MILLISECONDS = 10 * 60 * 1_000;
export const NATURAL_LANGUAGE_ACTION_CACHE_MAX_ENTRIES = 256;
export const NATURAL_LANGUAGE_ACTION_CACHE_TIME_BUCKET_MINUTES = 5;

export interface NaturalLanguageActionCacheChangeSource {
  getGeneration(): number;
  subscribe(listener: () => void): () => void;
}

export interface CachingNaturalLanguageActionPlannerOptions {
  readonly calendarChanges?: NaturalLanguageActionCacheChangeSource;
  readonly maxEntries?: number;
  readonly model: string;
  readonly ownerId: string;
  readonly planner: NaturalLanguageActionPlanner;
  readonly plannerVersion?: string;
  readonly ttlMilliseconds?: number;
}

interface CacheEntry {
  action: NaturalLanguageAction;
  calendarGeneration: number;
  readonly calendarDependent: boolean;
  readonly createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
}

interface CacheKeyInput {
  readonly context: NaturalLanguageActionPlanningInput["context"] | null;
  readonly localDate: string;
  readonly localTimeBucket: number;
  readonly model: string;
  readonly ownerId: string;
  readonly plannerVersion: string;
  readonly text: string;
  readonly timeZone: string;
}

/**
 * Caches only validated application actions. It never caches provider output,
 * Calendar data, rendered responses, credentials, or mutation results.
 */
export class CachingNaturalLanguageActionPlanner implements NaturalLanguageActionPlanner {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly plannerVersion: string;
  private readonly ttlMilliseconds: number;
  private readonly unsubscribe: (() => void) | undefined;

  public constructor(private readonly options: CachingNaturalLanguageActionPlannerOptions) {
    if (!options.ownerId.trim() || !options.model.trim()) {
      throw new Error("Natural-language action cache owner and model are required");
    }
    this.maxEntries = options.maxEntries ?? NATURAL_LANGUAGE_ACTION_CACHE_MAX_ENTRIES;
    this.ttlMilliseconds = options.ttlMilliseconds ?? NATURAL_LANGUAGE_ACTION_CACHE_TTL_MILLISECONDS;
    this.plannerVersion = options.plannerVersion ?? NATURAL_LANGUAGE_ACTION_CACHE_VERSION;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error("Natural-language action cache maxEntries must be a positive integer");
    }
    if (!Number.isInteger(this.ttlMilliseconds) || this.ttlMilliseconds <= 0) {
      throw new Error("Natural-language action cache ttlMilliseconds must be a positive integer");
    }

    this.unsubscribe = options.calendarChanges?.subscribe(() => this.invalidateCalendarActions());
  }

  public get size(): number {
    return this.entries.size;
  }

  public close(): void {
    this.unsubscribe?.();
    this.entries.clear();
  }

  public invalidateCalendarActions(): void {
    for (const [key, entry] of this.entries) {
      if (entry.calendarDependent) {
        this.entries.delete(key);
      }
    }
  }

  public async plan(input: NaturalLanguageActionPlanningInput): Promise<NaturalLanguageAction | undefined> {
    const cacheKey = buildCacheKey(input, {
      model: this.options.model,
      ownerId: this.options.ownerId,
      plannerVersion: this.plannerVersion,
    });
    if (cacheKey) {
      const cached = this.entries.get(cacheKey);
      if (cached) {
        const now = input.now.valueOf();
        if (cached.expiresAt <= now ||
          cached.calendarDependent && cached.calendarGeneration !== this.currentCalendarGeneration()) {
          this.entries.delete(cacheKey);
        } else {
          const validated = validateNaturalLanguageAction(cached.action, {
            now: input.now,
            timeZone: input.timeZone,
          });
          if (validated) {
            cached.action = validated;
            cached.lastUsedAt = now;
            return validated;
          }
          this.entries.delete(cacheKey);
        }
      }
    }

    const planned = await this.options.planner.plan(input);
    if (!planned) {
      return undefined;
    }
    const validated = validateNaturalLanguageAction(planned, {
      now: input.now,
      timeZone: input.timeZone,
    });
    if (!validated) {
      return undefined;
    }
    if (!cacheKey) {
      return validated;
    }

    const now = input.now.valueOf();
    this.evictExpired(now);
    if (!this.entries.has(cacheKey) && this.entries.size >= this.maxEntries) {
      this.evictLeastRecentlyUsed();
    }
    this.entries.set(cacheKey, {
      action: validated,
      calendarDependent: isCalendarDependent(validated),
      calendarGeneration: this.currentCalendarGeneration(),
      createdAt: now,
      expiresAt: now + this.ttlMilliseconds,
      lastUsedAt: now,
    });
    return validated;
  }

  private currentCalendarGeneration(): number {
    return this.options.calendarChanges?.getGeneration() ?? 0;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private evictLeastRecentlyUsed(): void {
    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsedAt < oldestTime) {
        oldestKey = key;
        oldestTime = entry.lastUsedAt;
      }
    }
    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}

function buildCacheKey(
  input: NaturalLanguageActionPlanningInput,
  options: Omit<CacheKeyInput, "context" | "localDate" | "localTimeBucket" | "text" | "timeZone">,
): string | undefined {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.valueOf()) ||
    typeof input.text !== "string" || !input.text.trim() ||
    typeof input.timeZone !== "string" || !IANAZone.isValidZone(input.timeZone)) {
    return undefined;
  }
  const localNow = DateTime.fromJSDate(input.now, { zone: input.timeZone });
  if (!localNow.isValid) {
    return undefined;
  }
  const key: CacheKeyInput = {
    ...options,
    context: input.context ? normalizeContext(input.context) : null,
    localDate: localNow.toFormat("yyyy-LL-dd"),
    localTimeBucket: Math.floor((localNow.hour * 60 + localNow.minute) / NATURAL_LANGUAGE_ACTION_CACHE_TIME_BUCKET_MINUTES),
    text: normalizeText(input.text),
    timeZone: input.timeZone,
  };
  return createHash("sha256").update(JSON.stringify(key), "utf8").digest("base64url");
}

function normalizeContext(
  context: NonNullable<NaturalLanguageActionPlanningInput["context"]>,
): NonNullable<CacheKeyInput["context"]> {
  return {
    clarificationQuestion: normalizeText(context.clarificationQuestion),
    originalRequest: normalizeText(context.originalRequest),
    reason: context.reason,
    recentMessages: context.recentMessages.map(normalizeText),
  };
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function isCalendarDependent(action: NaturalLanguageAction): boolean {
  switch (action.action) {
    case "create_calendar_event":
    case "list_calendar":
    case "move_calendar_event":
    case "delete_calendar_event":
    case "manage_calendar_attendees":
    case "set_calendar_reminder":
    case "show_agenda":
    case "cleanup_schedule":
      return true;
    case "create_task_or_reminder":
    case "list_tasks":
    case "complete_task":
    case "delete_task":
    case "ask_clarification":
      return false;
  }
}
