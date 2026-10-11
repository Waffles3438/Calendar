import type { CalendarReference } from "./calendar.js";

export const CALENDAR_TEMPLATE_IDS = [
  "benny-wang",
  "birthdates",
  "birthdays",
  "classes",
  "exams",
  "tasks",
] as const;

export type CalendarTemplateId = (typeof CALENDAR_TEMPLATE_IDS)[number];

export const CALENDAR_ACCESS_ROLES = [
  "freeBusyReader",
  "reader",
  "writerWithoutPrivateAccess",
  "writer",
  "owner",
  "unknown",
] as const;

export type CalendarAccessRole = (typeof CALENDAR_ACCESS_ROLES)[number];

export const CALENDAR_NAME_MAX_LENGTH = 160;
export const CALENDAR_DESCRIPTION_MAX_LENGTH = 2_000;
export const CALENDAR_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

export interface CalendarTemplate {
  readonly color: string;
  readonly description: string;
  readonly id: CalendarTemplateId;
  readonly name: string;
}

export interface CalendarTemplateInput {
  readonly color?: string;
  readonly description?: string;
  readonly name?: string;
  readonly templateId?: string;
}

export interface CalendarCreationDetails {
  readonly backgroundColor: string;
  readonly description: string;
  readonly foregroundColor: string;
  readonly name: string;
  readonly templateId: CalendarTemplateId;
}

export interface ManagedCalendar extends CalendarReference {
  readonly accessRole: CalendarAccessRole;
  readonly backgroundColor?: string;
  readonly canManageEvents: boolean;
  readonly canManageMetadata: boolean;
  readonly canDelete: boolean;
  readonly dataOwner?: string;
  readonly description?: string;
  readonly foregroundColor?: string;
  readonly hidden: boolean;
  readonly resourceEtag?: string;
  readonly selected: boolean;
  readonly summaryOverride?: string;
}

export interface CalendarMetadataPatch {
  readonly description?: string;
  readonly name?: string;
}

export interface CalendarListSettingsPatch {
  readonly backgroundColor?: string;
  readonly foregroundColor?: string;
  readonly hidden?: boolean;
  readonly selected?: boolean;
}

export interface CalendarManagementCapabilities {
  readonly canManageEvents: boolean;
  readonly canManageMetadata: boolean;
  readonly canDelete: boolean;
  readonly readOnly: boolean;
}

const TEMPLATES: readonly CalendarTemplate[] = [
  { color: "#4EA7D7", description: "Personal calendar", id: "benny-wang", name: "Benny Wang" },
  { color: "#E99C37", description: "Important dates", id: "birthdates", name: "Birthdates" },
  { color: "#68B88D", description: "Birthdays", id: "birthdays", name: "Birthdays" },
  { color: "#7770BA", description: "Classes and coursework", id: "classes", name: "Classes" },
  { color: "#F1C450", description: "Exams and assessments", id: "exams", name: "Exams" },
  { color: "#4EA7D7", description: "Tasks and deadlines", id: "tasks", name: "Tasks" },
];

export function listCalendarTemplates(): readonly CalendarTemplate[] {
  return TEMPLATES;
}

export function getCalendarTemplate(templateId?: string): CalendarTemplate {
  const normalized = templateId?.trim().toLocaleLowerCase() || "benny-wang";
  const template = TEMPLATES.find((candidate) => candidate.id === normalized);
  if (!template) {
    throw new Error(`Unknown calendar template: ${templateId ?? normalized}`);
  }
  return template;
}

export function resolveCalendarCreationDetails(input: CalendarTemplateInput = {}): CalendarCreationDetails {
  const template = getCalendarTemplate(input.templateId);
  const name = normalizeCalendarName(input.name ?? template.name);
  const description = normalizeCalendarDescription(input.description ?? template.description);
  const backgroundColor = normalizeCalendarColor(input.color ?? template.color);
  return {
    backgroundColor,
    description,
    foregroundColor: foregroundColorFor(backgroundColor),
    name,
    templateId: template.id,
  };
}

export function normalizeCalendarName(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    throw new Error("Calendar name must not be empty");
  }
  if (normalized.length > CALENDAR_NAME_MAX_LENGTH) {
    throw new Error(`Calendar name must not exceed ${CALENDAR_NAME_MAX_LENGTH} characters`);
  }
  return normalized;
}

export function normalizeCalendarDescription(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length > CALENDAR_DESCRIPTION_MAX_LENGTH) {
    throw new Error(`Calendar description must not exceed ${CALENDAR_DESCRIPTION_MAX_LENGTH} characters`);
  }
  return normalized;
}

export function normalizeCalendarColor(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!CALENDAR_COLOR_PATTERN.test(normalized)) {
    throw new Error("Calendar color must be a six-digit hexadecimal value such as #42A5F5");
  }
  return normalized;
}

export function foregroundColorFor(backgroundColor: string): string {
  const normalized = normalizeCalendarColor(backgroundColor).slice(1);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = (0.2126 * (linear[0] ?? 0)) + (0.7152 * (linear[1] ?? 0)) + (0.0722 * (linear[2] ?? 0));
  return luminance > 0.179 ? "#000000" : "#FFFFFF";
}

export function calendarCapabilities(
  accessRole: string | null | undefined,
  isPrimary: boolean,
): CalendarManagementCapabilities & { readonly accessRole: CalendarAccessRole } {
  const normalized = isCalendarAccessRole(accessRole) ? accessRole : "unknown";
  const canManageEvents = normalized === "writerWithoutPrivateAccess" || normalized === "writer" || normalized === "owner";
  const canManageMetadata = normalized === "owner";
  return {
    accessRole: normalized,
    canDelete: canManageMetadata && !isPrimary,
    canManageEvents,
    canManageMetadata,
    readOnly: !canManageEvents,
  };
}

export function isCalendarAccessRole(value: string | null | undefined): value is CalendarAccessRole {
  return typeof value === "string" && (CALENDAR_ACCESS_ROLES as readonly string[]).includes(value) && value !== "unknown";
}
