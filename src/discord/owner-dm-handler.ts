import type { Logger } from "pino";

export interface OwnerDirectMessage {
  readonly authorId: string;
  readonly content: string;
  readonly id: string;
  reply(content: string): Promise<void>;
}

export interface IncomingDiscordMessage extends OwnerDirectMessage {
  readonly isBot: boolean;
  readonly isDirectMessage: boolean;
}

export interface OwnerDmHandlerOptions {
  readonly logger: Logger;
  readonly onOwnerMessage: (message: OwnerDirectMessage) => Promise<void>;
  readonly ownerId: string;
}

/** Filters all Discord traffic before any command parsing or calendar access occurs. */
export function createOwnerDmHandler(options: OwnerDmHandlerOptions) {
  return async (message: IncomingDiscordMessage): Promise<boolean> => {
    if (message.isBot || !message.isDirectMessage) {
      return false;
    }

    if (message.authorId !== options.ownerId) {
      options.logger.warn(
        { authorId: message.authorId, messageId: message.id },
        "Ignored a Discord direct message from an unauthorized user",
      );
      return false;
    }

    await options.onOwnerMessage({
      authorId: message.authorId,
      content: message.content,
      id: message.id,
      reply: message.reply,
    });
    return true;
  };
}
