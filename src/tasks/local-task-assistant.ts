import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import {
  type PendingActionInstruction,
  type PendingActionMessageHandler,
  parsePendingActionInstruction,
} from "../application/pending-action.js";
import { markGeminiResponseUsed } from "../application/gemini-response-attribution.js";
import type { LegacyTaskCandidate } from "../application/named-delete-resolver.js";
import { formatDiscordDate } from "../discord/discord-timestamp.js";
import type { OwnerDirectMessage } from "../discord/owner-dm-handler.js";
import type { NaturalLanguageAction } from "../nlp/natural-language-action.js";
import type { PendingAction } from "../persistence/state-repository.js";
import {
  MAX_BULK_LOCAL_TASK_CANCELLATIONS,
  type CreateLocalTaskInput,
  type LocalTask,
  type LocalTaskBulkCancellationInput,
  type LocalTaskCancellationTarget,
  type LocalTaskOperation,
  type LocalTaskSelector,
  type LocalTaskTransitionInput,
} from "./task-domain.js";
import {
  isTaskShapedInput,
  parseDeterministicTaskCommand,
  type ParsedTaskCommand,
} from "./deterministic-task-parser.js";
import type { TaskCommandPlanner } from "./task-command-planner.js";
import {
  formatTaskDueAt,
  localTaskDate,
  localTaskDateBounds,
  validateLocalTaskDateTime,
} from "./task-time.js";
import { normalizeTaskSelectorTerms, titleMatchesTaskSelector } from "./task-selector.js";

export interface LocalTaskStateRepository {
  cancelLocalTask(input: LocalTaskTransitionInput): LocalTask | undefined;
  cancelLocalTasks(input: LocalTaskBulkCancellationInput): readonly LocalTask[] | undefined;
  completeLocalTask(input: LocalTaskTransitionInput): LocalTask | undefined;
  createLocalTask(input: CreateLocalTaskInput): LocalTask;
  createPendingAction(input: {
    expiresAt: Date;
    id: string;
    ownerId: string;
    payload: unknown;
  }): void;
  getLocalTask(input: { id: string; ownerId: string }): LocalTask | undefined;
  getPendingAction(input: { id: string; now: Date; ownerId: string }): PendingAction | undefined;
  consumePendingAction(input: { id: string; now: Date; ownerId: string }): PendingAction | undefined;
  listActiveLocalTasks(input: { limit?: number; ownerId: string }): readonly LocalTask[];
  listActiveLocalTasksInRange(input: {
    dueAtEarliest: Date;
    dueAtLatest: Date;
    limit: number;
    ownerId: string;
  }): readonly LocalTask[];
  recordAudit(input: {
    actionType: string;
    actorId: string;
    details?: Record<string, unknown>;
    status: "failed" | "succeeded";
  }): void;
}

export interface LocalTaskAssistantOptions {
  readonly commandPlanner?: TaskCommandPlanner;
  readonly dryRun?: boolean;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly ownerId: string;
  readonly pendingActionTtlMilliseconds?: number;
  readonly stateRepository: LocalTaskStateRepository;
  readonly timeZone: string;
}

type CommandSource = "deterministic" | "gemini";
type BulkCancellationScope = "date_scoped" | "unscoped_future";

interface PendingTaskCreate {
  readonly dueAt: string;
  readonly kind: "local_task_create";
  readonly source: "gemini";
  readonly timeZone: string;
  readonly title: string;
}

interface PendingTaskTransition {
  readonly expectedRevision: number;
  readonly kind: "local_task_transition";
  readonly operation: LocalTaskOperation;
  readonly source: "gemini";
  readonly taskId: string;
}

interface PendingTaskBulkCancellation {
  readonly cleanupScope: BulkCancellationScope;
  readonly kind: "local_task_bulk_cancel";
  readonly source: CommandSource;
  readonly tasks: readonly LocalTaskCancellationTarget[];
}

interface PendingTaskSelection {
  readonly candidateIds: readonly string[];
  readonly kind: "local_task_selection";
  readonly operation: LocalTaskOperation;
  readonly source: CommandSource;
}

type TaskPendingAction = PendingTaskBulkCancellation | PendingTaskCreate | PendingTaskSelection | PendingTaskTransition;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isLocalTaskOperation(value: unknown): value is LocalTaskOperation {
  return value === "complete" || value === "cancel";
}

function isCommandSource(value: unknown): value is CommandSource {
  return value === "deterministic" || value === "gemini";
}

function isPendingTaskCreate(value: unknown): value is PendingTaskCreate {
  return isRecord(value) &&
    value.kind === "local_task_create" &&
    value.source === "gemini" &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.dueAt === "string" &&
    Number.isFinite(Date.parse(value.dueAt)) &&
    typeof value.timeZone === "string" &&
    value.timeZone.trim().length > 0;
}

function isPendingTaskTransition(value: unknown): value is PendingTaskTransition {
  return isRecord(value) &&
    value.kind === "local_task_transition" &&
    value.source === "gemini" &&
    isLocalTaskOperation(value.operation) &&
    typeof value.taskId === "string" &&
    value.taskId.trim().length > 0 &&
    typeof value.expectedRevision === "number" &&
    Number.isInteger(value.expectedRevision) &&
    value.expectedRevision > 0;
}

function isLocalTaskCancellationTarget(value: unknown): value is LocalTaskCancellationTarget {
  return isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.expectedRevision === "number" &&
    Number.isInteger(value.expectedRevision) &&
    value.expectedRevision > 0;
}

function isPendingTaskBulkCancellation(value: unknown): value is PendingTaskBulkCancellation {
  if (!isRecord(value) ||
    value.kind !== "local_task_bulk_cancel" ||
    !isCommandSource(value.source) ||
    (value.cleanupScope !== "date_scoped" && value.cleanupScope !== "unscoped_future") ||
    !Array.isArray(value.tasks) ||
    value.tasks.length === 0 ||
    value.tasks.length > MAX_BULK_LOCAL_TASK_CANCELLATIONS ||
    !value.tasks.every(isLocalTaskCancellationTarget)) {
    return false;
  }

  return new Set(value.tasks.map((task) => task.id)).size === value.tasks.length;
}

function isPendingTaskSelection(value: unknown): value is PendingTaskSelection {
  return isRecord(value) &&
    value.kind === "local_task_selection" &&
    isLocalTaskOperation(value.operation) &&
    (value.source === "deterministic" || value.source === "gemini") &&
    Array.isArray(value.candidateIds) &&
    value.candidateIds.length > 0 &&
    value.candidateIds.every((id) => typeof id === "string" && id.trim().length > 0);
}

/** Allows owner-level dispatch to identify encrypted local-task actions safely. */
export function isLocalTaskPendingActionPayload(value: unknown): value is TaskPendingAction {
  return isPendingTaskBulkCancellation(value) ||
    isPendingTaskCreate(value) ||
    isPendingTaskSelection(value) ||
    isPendingTaskTransition(value);
}

/** Handles local task messages without reading from or writing to Google Calendar. */
export class LocalTaskAssistant implements PendingActionMessageHandler {
  private readonly now: () => Date;
  private readonly pendingActionTtlMilliseconds: number;

  public constructor(private readonly options: LocalTaskAssistantOptions) {
    this.now = options.now ?? (() => new Date());
    this.pendingActionTtlMilliseconds = options.pendingActionTtlMilliseconds ?? 10 * 60 * 1_000;
  }

  public isTaskInput(content: string): boolean {
    return isTaskShapedInput(content);
  }

  public canHandlePendingAction(payload: unknown): boolean {
    return isLocalTaskPendingActionPayload(payload);
  }

  public async handle(message: OwnerDirectMessage): Promise<void> {
    await this.handleMessage(message, false);
  }

  public async handleNaturalLanguage(message: OwnerDirectMessage): Promise<void> {
    await this.handleMessage(message, true);
  }

  /** Executes an already validated unified action without parsing generated text again. */
  public async handleNaturalLanguageAction(
    message: OwnerDirectMessage,
    action: Extract<NaturalLanguageAction, {
      action: "complete_task" | "create_task_or_reminder" | "delete_task" | "list_tasks";
    }>,
  ): Promise<void> {
    switch (action.action) {
      case "create_task_or_reminder":
        if (action.scheduleKind !== "task" || !action.startTime) {
          await message.reply("Please provide a one-time local task with a date and time.");
          return;
        }
        await this.handleCommand(message, {
          date: action.date,
          kind: "create",
          time: action.startTime,
          title: action.title,
        }, "gemini");
        return;
      case "list_tasks":
        await this.handleList(message, action.date);
        return;
      case "complete_task":
        await this.handleTransitionCommand(message, "complete", toLocalTaskSelector(action.selector), "gemini");
        return;
      case "delete_task":
        if (action.scope === "single" && action.selector) {
          await this.handleTransitionCommand(message, "cancel", toLocalTaskSelector({
            date: action.selector.date ?? action.date,
            title: action.selector.title,
          }), "gemini");
          return;
        }
        if (action.scope === "today" && action.date) {
          await this.handleBulkCancellation(message, action.date, true, "gemini");
          return;
        }
        await this.handleBulkCancellation(message, undefined, false, "gemini");
        return;
    }
  }

  /** Applies a resolver-captured task identity without running a second title search. */
  public async handleResolvedNamedCancellation(
    message: OwnerDirectMessage,
    candidate: LegacyTaskCandidate,
  ): Promise<void> {
    await this.executeTransition(message, "cancel", candidate.taskId, candidate.expectedRevision);
  }

  private async handleMessage(
    message: OwnerDirectMessage,
    allowNaturalLanguageFallback: boolean,
  ): Promise<void> {
    const pendingInstruction = parsePendingActionInstruction(message.content);
    if (pendingInstruction && await this.handlePendingAction(message, pendingInstruction)) {
      return;
    }

    const now = this.now();
    let command = parseDeterministicTaskCommand(message.content, {
      now,
      timeZone: this.options.timeZone,
    });
    let source: CommandSource = "deterministic";
    const shouldUsePlanner = this.options.commandPlanner &&
      ((command.kind === "clarify" && command.reason === "unsupported_intent") ||
        (allowNaturalLanguageFallback && command.kind === "not_task"));

    if (command.kind === "not_task" && !allowNaturalLanguageFallback) {
      await message.reply("I couldn't determine a local task command.");
      return;
    }

    if (shouldUsePlanner) {
      try {
        const planned = await this.options.commandPlanner.plan({
          now,
          text: message.content,
          timeZone: this.options.timeZone,
        });
        if (planned && planned.kind !== "not_task") {
          markGeminiResponseUsed(message);
          command = planned;
          if (planned.kind !== "clarify") {
            source = "gemini";
          }
        }
      } catch {
        // Keep the deterministic clarification when the optional model is unavailable.
      }
    }

    if (command.kind === "not_task") {
      await message.reply("I couldn't determine a local task command.");
      return;
    }

    await this.handleCommand(message, command, source);
  }

  public async handlePendingAction(
    message: OwnerDirectMessage,
    instruction: PendingActionInstruction,
  ): Promise<boolean> {
    const pending = this.options.stateRepository.getPendingAction({
      id: instruction.actionId,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    if (!pending || !isLocalTaskPendingActionPayload(pending.payload)) {
      return false;
    }
    if (pending.payload.source === "gemini") {
      markGeminiResponseUsed(message);
    }
    if (this.options.dryRun) {
      await message.reply("Dry run: no local task change was made.");
      return true;
    }

    if (instruction.kind === "cancel") {
      const consumed = this.consumeTaskPendingAction(instruction.actionId);
      if (!consumed) {
        return false;
      }
      await message.reply("Cancelled. No local task change was made.");
      return true;
    }

    if (instruction.kind === "confirm") {
      if (!isPendingTaskBulkCancellation(pending.payload) &&
        !isPendingTaskCreate(pending.payload) &&
        !isPendingTaskTransition(pending.payload)) {
        await message.reply("That confirmation is invalid or has expired.");
        return true;
      }
      const consumed = this.consumeTaskPendingAction(instruction.actionId);
      if (!consumed ||
        (!isPendingTaskBulkCancellation(consumed) &&
          !isPendingTaskCreate(consumed) &&
          !isPendingTaskTransition(consumed))) {
        await message.reply("That confirmation is invalid or has expired.");
        return true;
      }

      if (isPendingTaskCreate(consumed)) {
        await this.executeCreate(message, {
          dueAt: new Date(consumed.dueAt),
          timeZone: consumed.timeZone,
          title: consumed.title,
        });
      } else if (isPendingTaskTransition(consumed)) {
        await this.executeTransition(message, consumed.operation, consumed.taskId, consumed.expectedRevision);
      } else {
        await this.executeBulkCancellation(message, consumed.tasks, consumed.cleanupScope);
      }
      return true;
    }

    if (!isPendingTaskSelection(pending.payload)) {
      await message.reply("That selection is invalid or has expired.");
      return true;
    }

    const taskId = pending.payload.candidateIds[instruction.choice - 1];
    if (!taskId) {
      await message.reply("That selection number is not available. Reply with a number from the list.");
      return true;
    }

    const consumed = this.consumeTaskPendingAction(instruction.actionId);
    if (!consumed || !isPendingTaskSelection(consumed)) {
      await message.reply("That selection is invalid or has expired.");
      return true;
    }

    const selected = this.options.stateRepository.getLocalTask({
      id: taskId,
      ownerId: this.options.ownerId,
    });
    if (!selected || selected.status !== "active") {
      await message.reply("That task changed before it could be selected. Please repeat the request.");
      return true;
    }

    await this.applyTransitionForSource(message, consumed.operation, selected, consumed.source);
    return true;
  }

  private async handleCommand(
    message: OwnerDirectMessage,
    command: ParsedTaskCommand,
    source: CommandSource,
  ): Promise<void> {
    if (command.kind === "clarify") {
      await message.reply(command.message);
      return;
    }
    if (command.kind === "recurrence_unsupported") {
      await message.reply("Recurring local tasks are not supported yet. Please create a one-time task instead.");
      return;
    }
    if (command.kind === "list") {
      await this.handleList(message, command.date);
      return;
    }
    if (command.kind === "cancel_all") {
      if (source !== "deterministic") {
        await message.reply("Bulk local task deletion must use an explicit delete command.");
        return;
      }
      await this.handleBulkCancellation(message, command.date);
      return;
    }
    if (command.kind === "create") {
      const dueAt = this.resolveDueAt(command.date, command.time);
      if (!dueAt) {
        await message.reply("Please provide a valid future Toronto date and time for that task.");
        return;
      }
      await this.executeCreate(message, { dueAt, timeZone: this.options.timeZone, title: command.title });
      return;
    }
    if (command.kind === "complete" || command.kind === "cancel") {
      await this.handleTransitionCommand(message, command.kind, command.selector, source);
      return;
    }
  }

  private async handleList(message: OwnerDirectMessage, date?: string): Promise<void> {
    const displayLimit = 20;
    const bounds = date ? localTaskDateBounds(date, this.options.timeZone) : undefined;
    const tasks = date
      ? bounds
        ? this.options.stateRepository.listActiveLocalTasksInRange({
          dueAtEarliest: bounds.earliest,
          dueAtLatest: bounds.latest,
          limit: displayLimit + 1,
          ownerId: this.options.ownerId,
        })
        : []
      : this.options.stateRepository.listActiveLocalTasks({
        limit: displayLimit + 1,
        ownerId: this.options.ownerId,
      });
    const displayDate = date ? formatDiscordDate(date, this.options.timeZone) : undefined;
    if (tasks.length === 0) {
      await message.reply(`You have no active local tasks${displayDate ? ` for ${displayDate}` : ""}.`);
      return;
    }

    const visible = tasks.slice(0, displayLimit);
    const more = tasks.length > visible.length ? "\nMore active tasks exist; complete or cancel some to keep this list short." : "";
    const heading = displayDate
      ? `Active local tasks for ${displayDate} (${this.options.timeZone})`
      : `Active local tasks (${this.options.timeZone})`;
    await message.reply(
      `${heading}:\n${visible
        .map((task, index) => `${index + 1}. ${task.title} — ${formatTaskDueAt(task.dueAt, date ? this.options.timeZone : task.timeZone)}`)
        .join("\n")}${more}`,
    );
  }

  private async handleBulkCancellation(
    message: OwnerDirectMessage,
    date?: string,
    futureOnly = false,
    source: CommandSource = "deterministic",
  ): Promise<void> {
    const tasks = this.findBulkCancellationTasks(date, futureOnly);
    const scope = date ? ` for ${formatDiscordDate(date, this.options.timeZone)}` : "";
    const targetDescription = date && futureOnly
      ? "future active local tasks"
      : date ? "active local tasks" : "future active local tasks";
    if (tasks.length === 0) {
      await message.reply(`You have no ${targetDescription}${scope}.`);
      return;
    }
    if (tasks.length > MAX_BULK_LOCAL_TASK_CANCELLATIONS) {
      await message.reply(
        `I found more than ${MAX_BULK_LOCAL_TASK_CANCELLATIONS} ${targetDescription}${scope}. Narrow the request before deleting them.`,
      );
      return;
    }

    if (date && tasks.length === 1) {
      const task = tasks[0];
      if (task) {
        await this.executeTransition(message, "cancel", task.id, task.revision);
      }
      return;
    }

    await this.queueBulkCancellationConfirmation(message, tasks, date, futureOnly, source);
  }

  private findBulkCancellationTasks(date?: string, futureOnly = false): readonly LocalTask[] {
    const limit = MAX_BULK_LOCAL_TASK_CANCELLATIONS + 1;
    if (!date) {
      const now = this.now();
      return this.options.stateRepository.listActiveLocalTasksInRange({
        dueAtEarliest: new Date(now.valueOf() + 1),
        dueAtLatest: new Date("9999-12-31T23:59:59.999Z"),
        limit,
        ownerId: this.options.ownerId,
      });
    }

    const bounds = localTaskDateBounds(date, this.options.timeZone);
    if (!bounds) {
      return [];
    }
    const earliest = futureOnly
      ? new Date(Math.max(bounds.earliest.valueOf(), this.now().valueOf() + 1))
      : bounds.earliest;
    if (earliest > bounds.latest) {
      return [];
    }
    return this.options.stateRepository.listActiveLocalTasksInRange({
      dueAtEarliest: earliest,
      dueAtLatest: bounds.latest,
      limit,
      ownerId: this.options.ownerId,
    });
  }

  private async queueBulkCancellationConfirmation(
    message: OwnerDirectMessage,
    tasks: readonly LocalTask[],
    date?: string,
    futureOnly = false,
    source: CommandSource = "deterministic",
  ): Promise<void> {
    if (this.options.dryRun) {
      await message.reply("Dry run: no local task change was made; no confirmation was stored.");
      return;
    }

    const id = randomUUID();
    this.options.stateRepository.createPendingAction({
      expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
      id,
      ownerId: this.options.ownerId,
      payload: {
        cleanupScope: futureOnly || !date ? "unscoped_future" : "date_scoped",
        kind: "local_task_bulk_cancel",
        source,
        tasks: tasks.map((task) => ({ expectedRevision: task.revision, id: task.id })),
      } satisfies PendingTaskBulkCancellation,
    });
    const scope = date ? ` for ${formatDiscordDate(date, this.options.timeZone)}` : "";
    const targetDescription = date && !futureOnly ? "active local task" : "future active local task";
    const count = tasks.length;
    await message.reply(
      `Review: delete ${count} ${targetDescription}${count === 1 ? "" : "s"}${scope}. This will cancel ${count === 1 ? "it" : "them"} and stop future reminders. Reply confirm ${id} to continue or cancel ${id} to stop.`,
    );
  }

  private async executeBulkCancellation(
    message: OwnerDirectMessage,
    tasks: readonly LocalTaskCancellationTarget[],
    cleanupScope: BulkCancellationScope,
  ): Promise<void> {
    if (this.options.dryRun) {
      await message.reply("Dry run: no local task change was made.");
      return;
    }

    const now = this.now();
    if (cleanupScope === "unscoped_future" && !tasks.every((target) => {
      const task = this.options.stateRepository.getLocalTask({ id: target.id, ownerId: this.options.ownerId });
      return Boolean(task && task.status === "active" && task.revision === target.expectedRevision && task.dueAt > now);
    })) {
      this.audit("local_task_bulk_cancel", { count: tasks.length, reason: "tasks_changed_or_elapsed" }, "failed");
      await message.reply("One or more local tasks changed or are no longer future. No tasks were changed; please repeat the request.");
      return;
    }

    try {
      const cancelled = this.options.stateRepository.cancelLocalTasks({
        now,
        ownerId: this.options.ownerId,
        tasks,
      });
      if (!cancelled) {
        this.audit("local_task_bulk_cancel", { count: tasks.length, reason: "tasks_changed" }, "failed");
        await message.reply("One or more local tasks changed before they could be deleted. No tasks were changed; please repeat the request.");
        return;
      }

      this.audit("local_task_bulk_cancel", { count: cancelled.length }, "succeeded");
      await message.reply(`Cancelled ${cancelled.length} local task${cancelled.length === 1 ? "" : "s"}.`);
    } catch (error: unknown) {
      this.audit("local_task_bulk_cancel", { count: tasks.length }, "failed");
      this.options.logger.error({ error, taskCount: tasks.length }, "Local task bulk cancellation failed");
      await message.reply("I could not safely delete those local tasks. Please try again.");
    }
  }

  private async handleTransitionCommand(
    message: OwnerDirectMessage,
    operation: LocalTaskOperation,
    selector: LocalTaskSelector,
    source: CommandSource,
  ): Promise<void> {
    const matches = this.findMatchingTasks(selector);
    if (matches.length === 0) {
      await message.reply("I could not find an active local task matching that description.");
      return;
    }
    if (matches.length > 1) {
      await this.queueSelection(message, operation, matches, source);
      return;
    }

    const task = matches[0];
    if (!task) {
      await message.reply("I could not find an active local task matching that description.");
      return;
    }
    await this.applyTransitionForSource(message, operation, task, source);
  }

  private async applyTransitionForSource(
    message: OwnerDirectMessage,
    operation: LocalTaskOperation,
    task: LocalTask,
    _source: CommandSource,
  ): Promise<void> {
    await this.executeTransition(message, operation, task.id, task.revision);
  }

  private async executeCreate(
    message: OwnerDirectMessage,
    input: { readonly dueAt: Date; readonly timeZone: string; readonly title: string },
  ): Promise<void> {
    if (Number.isNaN(input.dueAt.valueOf()) || input.dueAt.valueOf() <= this.now().valueOf()) {
      this.audit("local_task_create", { reason: "due_time_passed" }, "failed");
      await message.reply("That task time has already passed. Please make a new request with a future time.");
      return;
    }

    if (this.options.dryRun) {
      await message.reply(
        `Dry run: would create local task ${input.title} — ${formatTaskDueAt(input.dueAt, input.timeZone)}. No local task change was made.`,
      );
      return;
    }

    try {
      const created = this.options.stateRepository.createLocalTask({
        dueAt: input.dueAt,
        id: randomUUID(),
        now: this.now(),
        ownerId: this.options.ownerId,
        timeZone: input.timeZone,
        title: input.title,
      });
      this.audit("local_task_create", { taskId: created.id }, "succeeded");
      await message.reply(`Created local task: ${created.title} — ${formatTaskDueAt(created.dueAt, created.timeZone)}.`);
    } catch (error: unknown) {
      this.audit("local_task_create", {}, "failed");
      this.options.logger.error({ error }, "Local task create failed");
      await message.reply("I could not create that local task. Please try again.");
    }
  }

  private async executeTransition(
    message: OwnerDirectMessage,
    operation: LocalTaskOperation,
    taskId: string,
    expectedRevision: number,
  ): Promise<void> {
    if (this.options.dryRun) {
      await message.reply("Dry run: no local task change was made.");
      return;
    }

    try {
      const task = operation === "complete"
        ? this.options.stateRepository.completeLocalTask({
          expectedRevision,
          id: taskId,
          now: this.now(),
          ownerId: this.options.ownerId,
        })
        : this.options.stateRepository.cancelLocalTask({
          expectedRevision,
          id: taskId,
          now: this.now(),
          ownerId: this.options.ownerId,
        });
      if (!task) {
        this.audit(`local_task_${operation}`, { reason: "task_changed", taskId }, "failed");
        await message.reply("That task changed before it could be updated. Please repeat the request.");
        return;
      }

      this.audit(`local_task_${operation}`, { taskId }, "succeeded");
      await message.reply(
        operation === "complete"
          ? `Completed local task: ${task.title}.`
          : `Cancelled local task: ${task.title}.`,
      );
    } catch (error: unknown) {
      this.audit(`local_task_${operation}`, { taskId }, "failed");
      this.options.logger.error({ error, taskId }, "Local task transition failed");
      await message.reply("I could not safely update that local task. Please try again.");
    }
  }

  private async queueCreateConfirmation(message: OwnerDirectMessage, title: string, dueAt: Date): Promise<void> {
    if (this.options.dryRun) {
      await message.reply("Dry run: no local task change was made; no confirmation was stored.");
      return;
    }

    const id = randomUUID();
    this.options.stateRepository.createPendingAction({
      expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
      id,
      ownerId: this.options.ownerId,
      payload: {
        dueAt: dueAt.toISOString(),
        kind: "local_task_create",
        source: "gemini",
        timeZone: this.options.timeZone,
        title,
      } satisfies PendingTaskCreate,
    });
    await message.reply(
      `Review: create local task ${title} — ${formatTaskDueAt(dueAt, this.options.timeZone)}. This action requires confirmation because it was model-proposed. Reply confirm ${id} to continue or cancel ${id} to stop.`,
    );
  }

  private async queueTransitionConfirmation(
    message: OwnerDirectMessage,
    operation: LocalTaskOperation,
    task: LocalTask,
  ): Promise<void> {
    if (this.options.dryRun) {
      await message.reply("Dry run: no local task change was made; no confirmation was stored.");
      return;
    }

    const id = randomUUID();
    this.options.stateRepository.createPendingAction({
      expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
      id,
      ownerId: this.options.ownerId,
      payload: {
        expectedRevision: task.revision,
        kind: "local_task_transition",
        operation,
        source: "gemini",
        taskId: task.id,
      } satisfies PendingTaskTransition,
    });
    await message.reply(
      `Review: ${operation} local task ${task.title} — ${formatTaskDueAt(task.dueAt, task.timeZone)}. This action requires confirmation because it was model-proposed. Reply confirm ${id} to continue or cancel ${id} to stop.`,
    );
  }

  private async queueSelection(
    message: OwnerDirectMessage,
    operation: LocalTaskOperation,
    tasks: readonly LocalTask[],
    source: CommandSource,
  ): Promise<void> {
    if (this.options.dryRun) {
      await message.reply("Dry run: no local task change was made; no task selection was stored.");
      return;
    }

    const id = randomUUID();
    this.options.stateRepository.createPendingAction({
      expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
      id,
      ownerId: this.options.ownerId,
      payload: {
        candidateIds: tasks.map((task) => task.id),
        kind: "local_task_selection",
        operation,
        source,
      } satisfies PendingTaskSelection,
    });
    await message.reply(
      `I found multiple active local tasks. Reply choose ${id} followed by a number:\n${tasks
        .map((task, index) => `${index + 1}. ${task.title} — ${formatTaskDueAt(task.dueAt, task.timeZone)}`)
        .join("\n")}`,
    );
  }

  private consumeTaskPendingAction(actionId: string): TaskPendingAction | undefined {
    const pending = this.options.stateRepository.consumePendingAction({
      id: actionId,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    return pending && isLocalTaskPendingActionPayload(pending.payload) ? pending.payload : undefined;
  }

  private findMatchingTasks(selector: LocalTaskSelector): readonly LocalTask[] {
    const terms = normalizeTaskSelectorTerms(selector.title);
    return this.options.stateRepository
      .listActiveLocalTasks({ ownerId: this.options.ownerId })
      .filter((task) =>
        (!selector.date || localTaskDate(task.dueAt, task.timeZone) === selector.date) &&
        titleMatchesTaskSelector(task.title, terms),
      );
  }

  private resolveDueAt(date: string, time: string): Date | undefined {
    const validation = validateLocalTaskDateTime(date, time, this.options.timeZone);
    if (validation.kind !== "valid" || validation.value.toMillis() <= this.now().valueOf()) {
      return undefined;
    }
    return validation.value.toUTC().toJSDate();
  }

  private audit(
    actionType: string,
    details: Record<string, unknown>,
    status: "failed" | "succeeded",
  ): void {
    if (this.options.dryRun) {
      return;
    }
    this.options.stateRepository.recordAudit({
      actionType,
      actorId: this.options.ownerId,
      details,
      status,
    });
  }
}

function toLocalTaskSelector(selector: { readonly date?: string | undefined; readonly title: string }): LocalTaskSelector {
  return {
    ...(selector.date ? { date: selector.date } : {}),
    title: selector.title,
  };
}
