import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppStateRepository } from "../src/persistence/state-repository.js";

const ownerId = "123456789012345678";
const otherOwnerId = "999999999999999999";
const now = new Date("2026-08-17T20:00:00.000Z");

 describe("encrypted natural-language context", () => {
  let directory: string | undefined;
  let repository: AppStateRepository | undefined;

  afterEach(async () => {
    repository?.close();
    repository = undefined;
    if (directory) {
      await rm(directory, { force: true, recursive: true });
      directory = undefined;
    }
  });

  async function createRepository(): Promise<{ databasePath: string; state: AppStateRepository }> {
    directory = await mkdtemp(join(tmpdir(), "calendar-context-"));
    const databasePath = join(directory, "calendar.sqlite");
    repository = new AppStateRepository({ databasePath, encryptionSecret: "x".repeat(48) });
    return { databasePath, state: repository };
  }

  it("stores, replaces, reads, and clears an owner-bound context", async () => {
    const { state } = await createRepository();
    const expiresAt = new Date("2026-08-17T20:10:00.000Z");
    state.saveNaturalLanguageContext({
      clarificationQuestion: "What time should I use?",
      expiresAt,
      now,
      originalRequest: "Remember to call the plumber tomorrow.",
      ownerId,
      recentMessages: [],
      reason: "missing_required_detail",
    });

    expect(state.getNaturalLanguageContext({ now, ownerId })).toMatchObject({
      clarificationQuestion: "What time should I use?",
      expiresAt,
      originalRequest: "Remember to call the plumber tomorrow.",
      reason: "missing_required_detail",
    });
    expect(state.getNaturalLanguageContext({ now, ownerId: otherOwnerId })).toBeUndefined();

    state.saveNaturalLanguageContext({
      clarificationQuestion: "Which day?",
      expiresAt,
      now,
      originalRequest: "Call the plumber.",
      ownerId,
      recentMessages: ["Tomorrow", "Actually, Friday"],
      reason: "missing_required_detail",
    });
    expect(state.getNaturalLanguageContext({ now, ownerId })).toMatchObject({
      clarificationQuestion: "Which day?",
      recentMessages: ["Tomorrow", "Actually, Friday"],
    });

    state.clearNaturalLanguageContext({ ownerId });
    expect(state.getNaturalLanguageContext({ now, ownerId })).toBeUndefined();
  });

  it("expires and encrypts context records", async () => {
    const { databasePath, state } = await createRepository();
    state.saveNaturalLanguageContext({
      clarificationQuestion: "What time?",
      expiresAt: new Date("2026-08-17T20:01:00.000Z"),
      now,
      originalRequest: "Call Mom tomorrow.",
      ownerId,
      recentMessages: [],
      reason: "missing_required_detail",
    });

    expect(state.getNaturalLanguageContext({
      now: new Date("2026-08-17T20:01:00.000Z"),
      ownerId,
    })).toBeUndefined();
    state.close();
    repository = undefined;
    const contents = await readFile(databasePath, "utf8");
    expect(contents).not.toContain("Call Mom tomorrow.");
    expect(contents).not.toContain("What time?");
  });
});
