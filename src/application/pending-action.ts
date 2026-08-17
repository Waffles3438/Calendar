import type { OwnerDirectMessage } from "../discord/owner-dm-handler.js";

export type PendingActionInstruction =
  | { readonly actionId: string; readonly kind: "cancel" }
  | { readonly actionId: string; readonly kind: "confirm" }
  | { readonly actionId: string; readonly choice: number; readonly kind: "choose" };

export interface PendingActionMessageHandler {
  canHandlePendingAction(payload: unknown): boolean;
  handlePendingAction(message: OwnerDirectMessage, instruction: PendingActionInstruction): Promise<boolean>;
}

export function parsePendingActionInstruction(content: string): PendingActionInstruction | undefined {
  const text = content.trim();
  const confirmation = /^confirm\s+([a-f0-9-]+)$/iu.exec(text);
  if (confirmation?.[1]) {
    return { actionId: confirmation[1], kind: "confirm" };
  }

  const cancellation = /^cancel\s+([a-f0-9-]+)$/iu.exec(text);
  if (cancellation?.[1]) {
    return { actionId: cancellation[1], kind: "cancel" };
  }

  const selection = /^choose\s+([a-f0-9-]+)\s+(\d+)$/iu.exec(text);
  if (selection?.[1] && selection[2]) {
    return { actionId: selection[1], choice: Number(selection[2]), kind: "choose" };
  }

  return undefined;
}

export function pendingActionInvalidMessage(kind: PendingActionInstruction["kind"]): string {
  if (kind === "choose") {
    return "That selection is invalid or has expired.";
  }
  return kind === "confirm"
    ? "That confirmation is invalid or has expired."
    : "That action is invalid or has expired.";
}
