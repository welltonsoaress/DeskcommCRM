import type { createAdminClient } from "@/lib/supabase/admin";
import { reportManagementDeliveryProblem } from "@/lib/management/failure";

type Admin = ReturnType<typeof createAdminClient>;

/** Recibos autenticados do canal só avançam o estado da saída conhecida. */
export async function recordManagementReceipt(admin: Admin, input: {
  organizationId: string; channelSessionId: string; externalIds: string[];
  status: "sent" | "delivered" | "read" | "failed";
}): Promise<void> {
  if (!input.externalIds.length) return;
  const ids = [...new Set(input.externalIds.filter(Boolean))];
  if (!ids.length) return;
  const now = new Date().toISOString();
  if (input.status === "failed") {
    const { error, data } = await admin.from("management_outbox" as never)
      .update({ error_code: "provider_delivery_failed" } as never)
      .eq("organization_id", input.organizationId)
      .eq("channel_session_id", input.channelSessionId)
      .eq("status", "accepted").in("external_id", ids).select("id");
    if (error) throw new Error(`management_receipt:${error.code ?? "unknown"}`);
    for (const row of (data ?? []) as { id: string }[])
      await reportManagementDeliveryProblem(admin, { organizationId: input.organizationId,
        outboxId: row.id, uncertain: true });
    return;
  }
  if (input.status === "sent") return;
  const { error } = await admin.from("management_outbox" as never)
    .update(input.status === "read" ? { delivered_at: now, read_at: now } as never
      : { delivered_at: now } as never)
    .eq("organization_id", input.organizationId)
    .eq("channel_session_id", input.channelSessionId)
    .eq("status", "accepted").in("external_id", ids);
  if (error) throw new Error(`management_receipt:${error.code ?? "unknown"}`);
}
