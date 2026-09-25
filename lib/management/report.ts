import { dayStartInTz } from "@/lib/agent-engine/pacing/engine";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { carregaRadarDeRisco } from "@/lib/leads/radar-de-risco";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Régua explícita: dia local da empresa, eventos novos pelo created_at. */
export async function managementSnapshot(admin: Admin, organizationId: string, now = new Date()) {
  const org = await admin.from("organizations").select("display_name, timezone")
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
    organization_name: org.data.display_name,
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

/** Dois blocos de sete dias locais completos, sem confundir o dia parcial com um dia inteiro. */
export function managementWeeklyPeriods(now: Date, timezone: string) {
  const end = dayStartInTz(now, timezone);
  const previousDay = (start: Date) => dayStartInTz(new Date(start.getTime() - 12 * 3_600_000), timezone);
  let currentStart = end;
  for (let day = 0; day < 7; day++) currentStart = previousDay(currentStart);
  let previousStart = currentStart;
  for (let day = 0; day < 7; day++) previousStart = previousDay(previousStart);
  return { previousStart, currentStart, end };
}

/** Números que já existem no CRM; nenhuma métrica clínica é inferida. */
export async function managementWeeklyComparison(admin: Admin, organizationId: string, now = new Date()) {
  const org = await admin.from("organizations").select("display_name, timezone")
    .eq("id", organizationId).maybeSingle();
  if (org.error || !org.data) throw new Error("management_organization_unavailable");
  const { previousStart, currentStart, end } = managementWeeklyPeriods(now, org.data.timezone);
  const interval = (start: Date, finish: Date) => ({ start: start.toISOString(), end: finish.toISOString() });
  const countLeads = (start: Date, finish: Date) => admin.from("crm_leads")
    .select("id", { count: "exact", head: true }).eq("organization_id", organizationId)
    .gte("created_at", start.toISOString()).lt("created_at", finish.toISOString());
  const countAppointments = (start: Date, finish: Date) => admin.from("calendar_appointments")
    .select("id", { count: "exact", head: true }).eq("organization_id", organizationId)
    .eq("status", "confirmed")
    .gte("starts_at", start.toISOString()).lt("starts_at", finish.toISOString());
  const [leadsNow, leadsBefore, appointmentsNow, appointmentsBefore] = await Promise.all([
    countLeads(currentStart, end), countLeads(previousStart, currentStart),
    countAppointments(currentStart, end), countAppointments(previousStart, currentStart),
  ]);
  if (leadsNow.error || leadsBefore.error || appointmentsNow.error || appointmentsBefore.error)
    throw new Error("management_weekly_metrics_unavailable");
  return {
    organization_name: org.data.display_name, timezone: org.data.timezone,
    measured_at: now.toISOString(),
    current: { ...interval(currentStart, end), new_leads: leadsNow.count ?? 0,
      confirmed_appointments: appointmentsNow.count ?? 0 },
    previous: { ...interval(previousStart, currentStart), new_leads: leadsBefore.count ?? 0,
      confirmed_appointments: appointmentsBefore.count ?? 0 },
  };
}

export function formatManagementWeeklyComparison(report: Awaited<ReturnType<typeof managementWeeklyComparison>>): string {
  const interval = (start: string, end: string) => {
    const fmt = new Intl.DateTimeFormat(tagDeIdioma(IDIOMA_PADRAO), { timeZone: report.timezone, day: "2-digit", month: "2-digit" });
    // end é exclusivo: o último dia incluído começou antes dele.
    return `${fmt.format(new Date(start))} a ${fmt.format(new Date(Date.parse(end) - 12 * 3_600_000))}`;
  };
  const diff = (current: number, previous: number) => `${current - previous >= 0 ? "+" : ""}${current - previous}`;
  return `Comparativo de ${report.organization_name} (${report.timezone}, dias completos): ` +
    `${interval(report.current.start, report.current.end)}: ${report.current.new_leads} oportunidades criadas e ` +
    `${report.current.confirmed_appointments} agendamentos atualmente confirmados. ` +
    `${interval(report.previous.start, report.previous.end)}: ${report.previous.new_leads} oportunidades e ` +
    `${report.previous.confirmed_appointments} agendamentos atualmente confirmados. ` +
    `Diferença: ${diff(report.current.new_leads, report.previous.new_leads)} oportunidades e ` +
    `${diff(report.current.confirmed_appointments, report.previous.confirmed_appointments)} agendamentos. ` +
    `O CRM não mede aqui atendimentos realizados, faltas ou faturamento.`;
}

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
