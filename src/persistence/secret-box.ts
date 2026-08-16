import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

interface EncryptedEnvelope {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly version: 1;
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const envelope = value as Partial<EncryptedEnvelope>;
  return (
    envelope.version === 1 &&
    typeof envelope.iv === "string" &&
    typeof envelope.tag === "string" &&
    typeof envelope.ciphertext === "string"
  );
}

/** Encrypts small, sensitive values before they are persisted locally. */
export class SecretBox {
  private readonly key: Buffer;

  public constructor(secret: string) {
    if (secret.trim().length < 32) {
      throw new Error("Encryption secret must contain at least 32 characters");
    }

    this.key = createHash("sha256").update(secret, "utf8").digest();
  }

  public encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    const envelope: EncryptedEnvelope = {
      ciphertext: ciphertext.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      version: 1,
    };

    return JSON.stringify(envelope);
  }

  public decrypt(serializedEnvelope: string): string {
    try {
      const parsed: unknown = JSON.parse(serializedEnvelope);
      if (!isEncryptedEnvelope(parsed)) {
        throw new Error("Encrypted payload has an invalid shape");
      }

      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(parsed.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
        decipher.final(),
      ]);

      return plaintext.toString("utf8");
    } catch {
      throw new Error("Unable to decrypt stored secret");
    }
  }
}
