import type { OwnerDirectMessage } from "../discord/owner-dm-handler.js";

interface GeminiResponseAttribution {
  readonly labelEnabled: boolean;
  usedGemini: boolean;
}

const attributions = new WeakMap<OwnerDirectMessage, GeminiResponseAttribution>();

/** Wraps one inbound owner message so accepted hosted-model decisions are disclosed on its replies. */
export function withGeminiResponseAttribution(
  message: OwnerDirectMessage,
  labelEnabled: boolean,
): OwnerDirectMessage {
  const attribution: GeminiResponseAttribution = { labelEnabled, usedGemini: false };
  const attributed: OwnerDirectMessage = {
    authorId: message.authorId,
    content: message.content,
    id: message.id,
    reply: async (content) => {
      await message.reply(
        attribution.labelEnabled && attribution.usedGemini && !content.trimEnd().endsWith("[Gemini]")
          ? `${content} [Gemini]`
          : content,
      );
    },
  };
  attributions.set(attributed, attribution);
  return attributed;
}

/** Marks the current routed response as having accepted a Gemini interpretation. */
export function markGeminiResponseUsed(message: OwnerDirectMessage): void {
  const attribution = attributions.get(message);
  if (attribution) {
    attribution.usedGemini = true;
  }
}
