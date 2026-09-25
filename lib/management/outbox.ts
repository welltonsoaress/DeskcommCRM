import type { createAdminClient } from "@/lib/supabase/admin";
import { sealVerificationBody } from "@/lib/management/challenge-envelope";

type Admin = ReturnType<typeof createAdminClient>;
export type ManagementOutboxKind = "verification" | "consultation" | "daily" | "weekly" | "alert";

/** A chave única conserva idempotência em reentregas e reinício do processo. */
export async function enqueueManagementDelivery(admin: Admin, input: {
  organizationId: string; channelSessionId: string; kind: ManagementOutboxKind;
  dedupeKey: string; body: string; verificationHash?: string;
  alertSource?: string; referenceId?: string; sensitiveBody?: boolean;
}): Promise<boolean> {
  const encrypted = input.kind === "verification" || input.sensitiveBody === true;
  const { error } = await admin.from("management_outbox" as never).insert({
    organization_id: input.organizationId,
    channel_session_id: input.channelSessionId,
    kind: input.kind, dedupe_key: input.dedupeKey,
    body: encrypted ? sealVerificationBody(input.body.slice(0, 3000))
      : input.body.slice(0, 3000), body_encrypted: encrypted, status: "pending",
    verification_hash: input.verificationHash ?? null,
    alert_source: input.alertSource ?? null, reference_id: input.referenceId ?? null,
  } as never);
  if (error?.code === "23505") return false;
  if (error) throw new Error(`management_outbox_insert:${error.code ?? "unknown"}`);
  return true;
}
