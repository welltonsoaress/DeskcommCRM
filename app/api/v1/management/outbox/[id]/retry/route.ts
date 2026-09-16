import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const auth = await requireRole("admin", { requestId, resource: "management_outbox", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail("validation_failed", "Envio inválido.", 422, { requestId });
  const admin = createAdminClient();
  const orgId = auth.org.orgId;
  const prior = await admin.from("management_outbox" as never)
    .select("id, kind, status, created_at, attempt_count")
    .eq("organization_id", orgId).eq("id", id).maybeSingle();
  if (prior.error || !prior.data) return fail("not_found", "Envio não encontrado nesta empresa.", 404, { requestId });
  const row = prior.data as { kind: string; status: string; created_at: string; attempt_count: number };
  if (row.status !== "failed") return fail("conflict", "Apenas falhas antes do transporte podem ser repetidas.", 409, { requestId });
  if (["daily", "alert"].includes(row.kind) && Date.now() - Date.parse(row.created_at) > 24 * 3_600_000)
    return fail("conflict", "Este aviso é antigo. Aguarde um resumo atual.", 409, { requestId });
  if (row.kind === "consultation" && Date.now() - Date.parse(row.created_at) > 2 * 24 * 3_600_000)
    return fail("conflict", "Esta resposta ficou antiga. Peça ao gestor para enviar uma pergunta nova.", 409, { requestId });
  if (row.attempt_count >= 5) return fail("conflict", "Limite de tentativas atingido; revise a conexão.", 409, { requestId });
  const { data, error } = await admin.from("management_outbox" as never)
    .update({ status: "pending", error_code: null, next_attempt_at: new Date().toISOString() } as never)
    .eq("organization_id", orgId).eq("id", id).eq("status", "failed")
    .select("id").maybeSingle();
  if (error || !data) return fail("conflict", "O estado do envio mudou.", 409, { requestId });
  await admin.from("agent_inbox_items").update({ status: "resolved" })
    .eq("organization_id", orgId).eq("ref_kind", "management_outbox")
    .eq("ref_id", id).eq("status", "open");
  await audit({ action: "management.delivery_retry_requested", actorUserId: auth.user.id,
    organizationId: orgId, resourceType: "management_outbox", resourceId: id,
    requestId, metadata: { attempt_count: row.attempt_count } });
  return ok({ pending: true }, { requestId });
}
