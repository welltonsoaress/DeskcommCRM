import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { loadManagementBinding } from "@/lib/management/ingress";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  channel_session_id: z.string().uuid(),
  manager_user_id: z.string().uuid(),
  manager_name: z.string().trim().min(1).max(120),
  manager_phone: z.string().trim().min(8).max(32),
  enabled: z.boolean().default(false),
  daily_enabled: z.boolean().default(false),
  daily_hour: z.number().int().min(0).max(23).default(9),
  alerts_enabled: z.boolean().default(false),
  alert_categories: z.array(z.enum(["central_critical", "radar_critical"])).max(2).default([]),
  max_daily_alerts: z.number().int().min(0).max(20).default(3),
  resume_alerts: z.boolean().default(false),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "management", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (!auth.user.support) {
    const adminCheck = await requireRole("admin", { requestId, resource: "management", allowPlatformAdmin: true });
    if (!adminCheck.ok) return adminCheck.response;
  }
  const admin = createAdminClient();
  const orgId = auth.org.orgId;
  const [binding, history, channels, memberships] = await Promise.all([
    admin.from("management_bindings" as never).select("organization_id, channel_session_id, manager_user_id, manager_name, manager_phone, enabled, verified_at, daily_enabled, daily_hour, alerts_enabled, alert_categories, max_daily_alerts, paused_at, challenge_expires_at")
      .eq("organization_id", orgId).maybeSingle(),
    admin.from("management_outbox" as never).select("id, kind, status, error_code, delivered_at, read_at, created_at, updated_at")
      .eq("organization_id", orgId).order("created_at", { ascending: false }).limit(30),
    admin.from("channel_sessions").select("id, display_name, phone_number, status")
      .eq("organization_id", orgId).is("archived_at", null)
      .in("provider", [...PROVIDERS_DE_MENSAGEM]).order("created_at"),
    admin.from("user_organizations").select("user_id, role, accepted_at, revoked_at")
      .eq("organization_id", orgId).is("revoked_at", null)
      .not("accepted_at", "is", null),
  ]);
  if (binding.error || history.error || channels.error || memberships.error)
    return fail("internal_error", "Não foi possível ler a gestão.", 500, { requestId });
  const members = await Promise.all((memberships.data ?? []).filter((m) => ["admin", "manager"].includes(m.role))
    .map(async (m) => {
      const { data } = await admin.auth.admin.getUserById(m.user_id);
      return { ...m, full_name: typeof data?.user?.user_metadata?.full_name === "string"
        ? data.user.user_metadata.full_name : null, email: data?.user?.email ?? null };
    }));
  return ok({ binding: binding.data, history: history.data ?? [],
    sessions: channels.data ?? [], members }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const auth = await requireRole("admin", { requestId, resource: "management", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Dados inválidos.", 422, { requestId });
  const input = parsed.data;
  const orgId = auth.org.orgId;
  const phone = canonicalPhoneBR(input.manager_phone);
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone))
    return fail("validation_failed", "Informe o WhatsApp do gestor com DDI.", 422, { requestId });

  const admin = createAdminClient();
  const [session, member, old] = await Promise.all([
    admin.from("channel_sessions").select("id, provider").eq("organization_id", orgId)
      .eq("id", input.channel_session_id).is("archived_at", null).maybeSingle(),
    admin.from("user_organizations").select("id, role").eq("organization_id", orgId)
      .eq("user_id", input.manager_user_id).is("revoked_at", null)
      .not("accepted_at", "is", null).maybeSingle(),
    admin.from("management_bindings" as never).select("*").eq("organization_id", orgId).maybeSingle(),
  ]);
  if (session.error || member.error || old.error) return fail("internal_error", "Não foi possível validar empresa, gestor e comercial.", 500, { requestId });
  if (!session.data || !PROVIDERS_DE_MENSAGEM.includes(session.data.provider as (typeof PROVIDERS_DE_MENSAGEM)[number])
      || !member.data || !["manager", "admin"].includes(member.data.role))
    return fail("forbidden_tenant", "Escolha um comercial e gestor ativo desta empresa.", 403, { requestId });
  const previous = old.data as { channel_session_id: string; manager_user_id: string; manager_phone: string;
    verified_at: string | null; paused_at: string | null; challenge_hash: string | null;
    challenge_expires_at: string | null; challenge_attempts: number } | null;
  const changed = !previous || previous.channel_session_id !== input.channel_session_id
    || previous.manager_user_id !== input.manager_user_id || previous.manager_phone !== phone;
  if (input.enabled && (changed || !previous?.verified_at))
    return fail("forbidden", "Confirme o número do gestor pelo comercial antes de ativar.", 403, { requestId });

  const { error } = await admin.from("management_bindings" as never).upsert({
    organization_id: orgId,
    channel_session_id: input.channel_session_id,
    manager_user_id: input.manager_user_id,
    manager_name: input.manager_name,
    manager_phone: phone,
    enabled: input.enabled && !changed,
    verified_at: changed ? null : previous?.verified_at,
    challenge_hash: changed ? null : previous?.challenge_hash,
    challenge_expires_at: changed ? null : previous?.challenge_expires_at,
    challenge_attempts: changed ? 0 : previous?.challenge_attempts ?? 0,
    daily_enabled: input.daily_enabled,
    daily_hour: input.daily_hour,
    alerts_enabled: input.alerts_enabled,
    alert_categories: input.alert_categories,
    max_daily_alerts: input.max_daily_alerts,
    paused_at: changed || input.resume_alerts ? null : previous?.paused_at,
    configured_by: auth.user.id,
  } as never, { onConflict: "organization_id" });
  if (error) return fail("internal_error", "Não foi possível salvar a configuração.", 500, { requestId });
  if (changed || !input.enabled) {
    await admin.from("management_outbox" as never).update({ status: "cancelled" } as never)
      .eq("organization_id", orgId).eq("status", "pending");
  }
  await audit({ action: "management.binding_updated", actorUserId: auth.user.id,
    organizationId: orgId, resourceType: "management_binding", resourceId: orgId,
    requestId, metadata: { changed, enabled: input.enabled, daily_enabled: input.daily_enabled, alerts_enabled: input.alerts_enabled } });
  const current = await loadManagementBinding(admin, orgId, input.channel_session_id);
  return ok({ enabled: current?.enabled ?? false, verified: !!current?.verified_at }, { requestId });
}
