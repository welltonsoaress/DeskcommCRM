import { createHmac } from "node:crypto";

import { env } from "@/lib/env";

export interface ManagementActionIdentity {
  organizationId: string; channelSessionId: string; managerUserId: string;
}

export function managementActionCodeHash(input: ManagementActionIdentity, code: string): string {
  return createHmac("sha256", env.INTERNAL_SECRET)
    .update(`management-action:${input.organizationId}:${input.channelSessionId}:${input.managerUserId}:${code}`)
    .digest("hex");
}

export function managementConfirmationHash(input: ManagementActionIdentity, body: string): string | null {
  const match = /^confirmar\s+(\d{6})$/i.exec(body.trim());
  return match ? `confirm:${managementActionCodeHash(input, match[1]!)}` : null;
}
