import { dayStartInTz } from "@/lib/agent-engine/pacing/engine";
import { carregaRadarDeRisco } from "@/lib/leads/radar-de-risco";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Régua explícita: dia local da empresa, eventos novos pelo created_at. */
export async function managementSnapshot(admin: Admin, organizationId: string, now = new Date()) {
  const org = await admin.from("organizations").select("name, timezone")
    .eq("id", organizationId).maybeSingle();
  if (org.error || !org.data) throw new Error("management_organization_unavailable");
  const timezone = org.data.timezone;
  const start = dayStartInTz(now, timezone);
  const next = dayStartInTz(new Date(start.getTime() + 36 * 3_600_000), timezone);
  const [newLeads, openLeads, inbox, appointments, radar] = await Promise.all([
    admin.from("crm_leads").select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId).gte("created_at", start.toISOString()).lt("created_at", next.toISOString()),
    admin.from("crm_leads").select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId).eq("status", "open"),
    admin.from("agent_inbox_items").select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId).eq("status", "open"),
    admin.from("calendar_appointments").select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId).eq("status", "confirmed")
      .gte("starts_at", start.toISOString()).lt("starts_at", next.toISOString()),
    carregaRadarDeRisco(admin, { organizationId, limit: 5, now, humanRole: "manager" }),
  ]);
  if (newLeads.error || openLeads.error || inbox.error || appointments.error)
    throw new Error("management_metrics_unavailable");
  return {
    organization_name: org.data.name,
    timezone,
    period_start: start.toISOString(), period_end: next.toISOString(),
    measured_at: now.toISOString(),
    new_leads: newLeads.count ?? 0,
    open_leads: openLeads.count ?? 0,
    open_inbox_alerts: inbox.count ?? 0,
    confirmed_appointments_today: appointments.count ?? 0,
    radar: {
      critical: radar.counts.critico,
      at_risk: radar.counts.em_risco,
      without_next_step: radar.total_sem_proximo_passo,
      coverage: "varredura limitada a até 500 negócios abertos e 500 demandas sem próximo passo",
    },
    next_step: "/app/radar",
  };
}

export type ManagementSnapshot = Awaited<ReturnType<typeof managementSnapshot>>;

export function formatManagementSummary(snapshot: ManagementSnapshot): string {
  const day = new Intl.DateTimeFormat("pt", { timeZone: snapshot.timezone, dateStyle: "short" })
    .format(new Date(snapshot.period_start));
  return `Resumo de ${snapshot.organization_name} (${day}, ${snapshot.timezone}): ` +
    `${snapshot.new_leads} oportunidades criadas hoje; ${snapshot.open_leads} negócios abertos; ` +
    `${snapshot.open_inbox_alerts} avisos abertos na Central; ` +
    `${snapshot.confirmed_appointments_today} agendamentos confirmados hoje. ` +
    `Radar: ${snapshot.radar.critical} críticos, ${snapshot.radar.at_risk} em risco, ` +
    `${snapshot.radar.without_next_step} demandas sem próximo passo ` +
    `(${snapshot.radar.coverage}). Veja o Radar na aplicação para decidir o atendimento.`;
}
