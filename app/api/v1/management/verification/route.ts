import { randomInt, randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels";
import { challengeHash } from "@/lib/management/ingress";
import { enqueueManagementDelivery } from "@/lib/management/outbox";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const auth = await requireRole("admin", { requestId, resource: "management", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const admin = createAdminClient();
  const orgId = auth.org.orgId;
  const { data: binding, error } = await admin.from("management_bindings" as never)
    .select("channel_session_id, manager_user_id, manager_name, manager_phone, verified_at, challenge_hash, challenge_expires_at, updated_at")
    .eq("organization_id", orgId).maybeSingle();
  if (error || !binding) return fail("not_found", "Cadastre o gestor e o comercial antes de confirmar.", 404, { requestId });
  const b = binding as { channel_session_id: string; manager_user_id: string; manager_name: string;
    manager_phone: string; verified_at: string | null; challenge_hash: string | null;
    challenge_expires_at: string | null; updated_at: string };
  if (b.verified_at) return fail("conflict", "Este número já foi confirmado.", 409, { requestId });
  if (b.challenge_hash && (b.challenge_expires_at === null
    || Date.parse(b.challenge_expires_at) > Date.now())) {
    const active = await admin.from("management_outbox" as never)
      .select("status, created_at").eq("organization_id", orgId)
      .eq("kind", "verification").eq("verification_hash", b.challenge_hash)
      .in("status", ["pending", "sending", "accepted"])
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (active.error) return fail("internal_error", "Não foi possível verificar o código anterior.", 500, { requestId });
    const queued = active.data as { status: string; created_at: string } | null;
    if (queued && (queued.status !== "accepted" || (b.challenge_expires_at
      ? Date.parse(b.challenge_expires_at) > Date.now()
      : Date.now() - Date.parse(queued.created_at) < 10 * 60_000)))
      return fail("conflict", "Já existe um código na fila ou ainda válido.", 409, { requestId });
  }
  const [session, membership] = await Promise.all([
    admin.from("channel_sessions").select("status, provider").eq("organization_id", orgId)
      .eq("id", b.channel_session_id).is("archived_at", null).maybeSingle(),
    admin.from("user_organizations").select("id").eq("organization_id", orgId)
      .eq("user_id", b.manager_user_id).in("role", ["manager", "admin"])
      .is("revoked_at", null)
      .not("accepted_at", "is", null).maybeSingle(),
  ]);
  if (session.error || membership.error) return fail("internal_error", "Não foi possível validar a conexão.", 500, { requestId });
  if (!session.data || session.data.status !== "WORKING"
      || !PROVIDERS_DE_MENSAGEM.includes(session.data.provider as (typeof PROVIDERS_DE_MENSAGEM)[number])
      || !membership.data)
    return fail("upstream_unavailable", "Conecte o comercial e confirme o usuário antes do teste.", 503, { requestId });

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hash = challengeHash(orgId, b.channel_session_id, code);
  const { error: saveError, data: saved } = await admin.from("management_bindings" as never)
    .update({ challenge_hash: hash, challenge_expires_at: null, challenge_attempts: 0 } as never)
    .eq("organization_id", orgId).eq("channel_session_id", b.channel_session_id)
    .eq("updated_at", b.updated_at).is("verified_at", null)
    .select("organization_id").maybeSingle();
  if (saveError || !saved) return fail("conflict", "O cadastro mudou; recarregue e tente novamente.", 409, { requestId });
  await admin.from("management_outbox" as never).update({ status: "cancelled" } as never)
    .eq("organization_id", orgId).eq("kind", "verification").eq("status", "pending");
  try {
    await enqueueManagementDelivery(admin, { organizationId: orgId,
      channelSessionId: b.channel_session_id, kind: "verification",
      dedupeKey: `verification:${requestId}`,
      verificationHash: hash,
      body: `Olá, ${b.manager_name}. Para confirmar o assistente de gestão desta empresa, responda com o código ${code}. Ele expira em 10 minutos.`,
    });
  } catch {
    return fail("internal_error", "A confirmação não entrou na fila. Tente novamente.", 500, { requestId });
  }
  await audit({ action: "management.verification_requested", actorUserId: auth.user.id,
    organizationId: orgId, resourceType: "management_binding", resourceId: orgId,
    requestId, metadata: { queued: true } });
  return ok({ pending: true }, { requestId });
}
