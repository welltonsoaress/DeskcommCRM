import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

const PREFIX = "mgmt-code-v1:";

function key(): Buffer {
  return createHash("sha256").update(`management-verification-body:${env.INTERNAL_SECRET}`).digest();
}

/** O outbox precisa sobreviver a restart sem manter o código em texto aberto. */
export function sealVerificationBody(plain: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url")}`;
}

export function openVerificationBody(sealed: string): string {
  if (!sealed.startsWith(PREFIX)) throw new Error("management_challenge_envelope_invalid");
  const packed = Buffer.from(sealed.slice(PREFIX.length), "base64url");
  if (packed.length < 29) throw new Error("management_challenge_envelope_invalid");
  const decipher = createDecipheriv("aes-256-gcm", key(), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
}
