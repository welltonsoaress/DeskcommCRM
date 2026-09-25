import { describe, expect, it } from "vitest";

import { formatManagementWeeklyComparison, managementWeeklyPeriods } from "./report";

describe("comparativo semanal da gestão", () => {
  it("usa 14 dias locais completos mesmo na mudança de horário de verão", () => {
    const periods = managementWeeklyPeriods(new Date("2026-03-10T18:00:00Z"), "America/New_York");
    expect(periods.end.toISOString()).toBe("2026-03-10T04:00:00.000Z");
    expect(periods.currentStart.toISOString()).toBe("2026-03-03T05:00:00.000Z");
    expect(periods.previousStart.toISOString()).toBe("2026-02-24T05:00:00.000Z");
  });

  it("declara a cobertura e a diferença sem inventar indicadores clínicos", () => {
    const text = formatManagementWeeklyComparison({
      organization_name: "Clínica de teste", timezone: "America/Fortaleza",
      measured_at: "2026-09-24T18:00:00Z",
      current: { start: "2026-09-17T03:00:00Z", end: "2026-09-24T03:00:00Z",
        new_leads: 5, confirmed_appointments: 2 },
      previous: { start: "2026-09-10T03:00:00Z", end: "2026-09-17T03:00:00Z",
        new_leads: 3, confirmed_appointments: 4 },
    });
    expect(text).toContain("Diferença: +2 oportunidades e -2 agendamentos");
    expect(text).toContain("não mede aqui atendimentos realizados, faltas ou faturamento");
  });
});
