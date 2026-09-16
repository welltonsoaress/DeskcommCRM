import type pg from "pg";

import { dayStartInTz } from "@/lib/agent-engine/pacing/engine";
import { answerManagementQuestion } from "@/lib/management/consultation";
import { loadManagementBinding } from "@/lib/management/ingress";
import { enqueueManagementDelivery } from "@/lib/management/outbox";
import { formatManagementSummary, managementSnapshot } from "@/lib/management/report";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

interface MessageJob { id: string; organization_id: string; channel_session_id: string;
  kind: "consultation" | "pause"; body: string | null; created_at: Date; }

async function claimMessage(pool: pg.Pool): Promise<MessageJob | null> {
  const { rows } = await pool.query<MessageJob>(`
    with picked as (
      select m.id from public.management_messages m
      left join public.management_outbox o
        on o.organization_id = m.organization_id and o.dedupe_key = 'reply:' || m.id::text
      where m.direction = 'inbound' and m.kind in ('consultation', 'pause')
        and o.id is null and (m.claim_until is null or m.claim_until < now())
      order by m.created_at for update of m skip locked limit 1
    )
    update public.management_messages m set claim_until = now() + interval '5 minutes'
    from picked where m.id = picked.id
    returning m.id, m.organization_id, m.channel_session_id, m.kind, m.body, m.created_at
  `);
  return rows[0] ?? null;
}

export async function produceManagementReplies(admin: Admin, pool: pg.Pool, limit = 2): Promise<number> {
  let produced = 0;
  while (produced < limit) {
    const msg = await claimMessage(pool);
    if (!msg) break;
    const binding = await loadManagementBinding(admin, msg.organization_id, msg.channel_session_id);
    if (!binding?.enabled || !binding.verified_at) {
      await pool.query("update public.management_messages set kind = 'ignored' where id = $1", [msg.id]);
      continue;
    }
    const member = await admin.from("user_organizations").select("id")
      .eq("organization_id", msg.organization_id).eq("user_id", binding.manager_user_id)
      .in("role", ["manager", "admin"]).is("revoked_at", null)
      .not("accepted_at", "is", null).maybeSingle();
    if (member.error) throw new Error("management_reply_membership_unavailable");
    if (!member.data) {
      await pool.query("update public.management_messages set kind = 'ignored' where id = $1", [msg.id]);
      continue;
    }
    const body = Date.now() - new Date(msg.created_at).getTime() > 2 * 24 * 3_600_000
      ? "Sua pergunta ficou pendente por mais de dois dias. Para receber informações atuais, envie a pergunta novamente."
      : msg.kind === "pause"
      ? "Avisos automáticos pausados. Você ainda pode fazer perguntas aqui. Para reativar avisos, peça a um administrador para ajustar o Assistente de gestão na aplicação."
      : await answerManagementQuestion(admin, pool, {
          organizationId: msg.organization_id, managerUserId: binding.manager_user_id,
          channelSessionId: msg.channel_session_id,
          question: msg.body ?? "",
        });
    if (await enqueueManagementDelivery(admin, { organizationId: msg.organization_id,
      channelSessionId: msg.channel_session_id, kind: "consultation",
      dedupeKey: `reply:${msg.id}`, body })) produced++;
  }
  return produced;
}

interface ScheduleRow { organization_id: string; channel_session_id: string;
  daily_enabled: boolean; daily_hour: number; alerts_enabled: boolean;
  alert_categories: string[]; max_daily_alerts: number; paused_at: Date | null;
  timezone: string; }

function localParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const read = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "00";
  return { day: `${read("year")}-${read("month")}-${read("day")}`, hour: Number(read("hour")) };
}

async function alreadyQueued(admin: Admin, organizationId: string, dedupeKey: string): Promise<boolean> {
  const result = await admin.from("management_outbox" as never).select("id")
    .eq("organization_id", organizationId).eq("dedupe_key", dedupeKey).limit(1);
  if (result.error) throw new Error("management_schedule_dedupe_unavailable");
  return ((result.data ?? []) as { id: string }[]).length > 0;
}

/** Sem backfill de dias antigos: apenas o dia/hora local observados nesta passada. */
export async function produceManagementSchedule(admin: Admin, pool: pg.Pool, now = new Date()): Promise<{ daily: number; alerts: number }> {
  const { rows } = await pool.query<ScheduleRow>(`
    select b.organization_id, b.channel_session_id, b.daily_enabled, b.daily_hour,
           b.alerts_enabled, b.alert_categories, b.max_daily_alerts, b.paused_at,
           o.timezone from public.management_bindings b
    join public.organizations o on o.id = b.organization_id
    where b.enabled and b.verified_at is not null and (b.daily_enabled or b.alerts_enabled)
    order by b.organization_id
  `);
  if (!rows.length) return { daily: 0, alerts: 0 };
  // Toda empresa é observada neste minuto. A chave única evita repetição de
  // resumo/alerta; um limite fixo aqui perderia empresas na hora do resumo.
  const page = rows;
  let daily = 0; let alerts = 0;
  for (const b of page) {
    if (b.paused_at) continue;
    const local = localParts(now, b.timezone);
    const dailyKey = `daily:${local.day}`;
    if (b.daily_enabled && local.hour === b.daily_hour
        && !await alreadyQueued(admin, b.organization_id, dailyKey)) {
      const snap = await managementSnapshot(admin, b.organization_id, now);
      if (await enqueueManagementDelivery(admin, { organizationId: b.organization_id,
        channelSessionId: b.channel_session_id, kind: "daily",
        dedupeKey: dailyKey, body: formatManagementSummary(snap) })) daily++;
    }
    if (!b.alerts_enabled || b.max_daily_alerts === 0) continue;
    const dayStart = dayStartInTz(now, b.timezone).toISOString();
    const existing = await admin.from("management_outbox" as never)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", b.organization_id).eq("kind", "alert")
      .gte("created_at", dayStart);
    if (existing.error) throw new Error("management_alert_volume_unavailable");
    let remaining = Math.max(0, b.max_daily_alerts - (existing.count ?? 0));
    if (remaining && b.alert_categories.includes("central_critical")) {
      const critical = await admin.from("agent_inbox_items")
        .select("id").eq("organization_id", b.organization_id)
        .eq("severity", "critical").eq("status", "open")
        .gte("created_at", dayStart).order("created_at", { ascending: false }).limit(remaining);
      if (critical.error) throw new Error("management_central_alert_unavailable");
      for (const item of critical.data ?? []) {
        if (remaining <= 0) break;
        if (await enqueueManagementDelivery(admin, { organizationId: b.organization_id,
          channelSessionId: b.channel_session_id, kind: "alert",
          dedupeKey: `alert:central:${item.id}`, alertSource: "central_critical",
          referenceId: item.id,
          body: "Há um aviso crítico aberto na Central. Abra a aplicação para ver o contexto e o próximo passo.",
        })) { alerts++; remaining--; }
      }
    }
    const radarKey = `alert:radar:${local.day}`;
    if (remaining && b.alert_categories.includes("radar_critical")
        && !await alreadyQueued(admin, b.organization_id, radarKey)) {
      const snap = await managementSnapshot(admin, b.organization_id, now);
      if (snap.radar.critical > 0 && await enqueueManagementDelivery(admin, {
        organizationId: b.organization_id, channelSessionId: b.channel_session_id,
        kind: "alert", alertSource: "radar_critical",
        dedupeKey: radarKey,
        body: `O Radar encontrou ${snap.radar.critical} negócios críticos na varredura limitada. Abra o Radar para decidir o próximo passo.`,
      })) alerts++;
    }
  }
  return { daily, alerts };
}
