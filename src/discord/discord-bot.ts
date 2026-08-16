import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import type { Logger } from "pino";

import {
  createOwnerDmHandler,
  type OwnerDirectMessage,
} from "./owner-dm-handler.js";

export interface DiscordBotOptions {
  readonly logger: Logger;
  readonly onOwnerDirectMessage: (message: OwnerDirectMessage) => Promise<void>;
  readonly ownerId: string;
  readonly token: string;
}

/**
 * Thin Discord gateway adapter. It requests only direct-message events and
 * never processes guild messages or any message from a user other than the owner.
 */
export class DiscordBot {
  private readonly client: Client;
  private readonly logger: Logger;
  private readonly ownerId: string;
  private readonly token: string;
  private readonly handleOwnerMessage: ReturnType<typeof createOwnerDmHandler>;

  public constructor(options: DiscordBotOptions) {
    this.client = new Client({
      intents: [GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
    });
    this.logger = options.logger;
    this.ownerId = options.ownerId;
    this.token = options.token;
    this.handleOwnerMessage = createOwnerDmHandler({
      logger: options.logger,
      onOwnerMessage: options.onOwnerDirectMessage,
      ownerId: options.ownerId,
    });

    this.client.once(Events.ClientReady, (client) => {
      this.logger.info({ userId: client.user.id }, "Discord bot connected");
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.handleDiscordMessage(message);
    });
  }

  public async start(): Promise<void> {
    await this.client.login(this.token);
  }

  public async stop(): Promise<void> {
    this.client.destroy();
  }

  public async sendOwnerMessage(content: string): Promise<void> {
    const owner = await this.client.users.fetch(this.ownerId);
    await owner.send({ content });
  }

  private async handleDiscordMessage(message: Message): Promise<void> {
    try {
      await this.handleOwnerMessage({
        authorId: message.author.id,
        content: message.content,
        id: message.id,
        isBot: message.author.bot,
        isDirectMessage: message.channel.type === ChannelType.DM,
        reply: async (content) => {
          await message.reply({ content });
        },
      });
    } catch (error: unknown) {
      this.logger.error({ error, messageId: message.id }, "Failed to handle Discord message");
    }
  }
}
