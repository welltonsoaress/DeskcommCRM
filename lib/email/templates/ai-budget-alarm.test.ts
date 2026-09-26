import { describe, expect, it } from "vitest";

import { DEFAULT_APP_NAME } from "@/lib/branding";
import { buildBudgetAlarmEmail } from "./ai-budget-alarm";

const base = {
  pct: 85,
  consumedCents: 8500,
  limitCents: 10000,
  dashboardUrl: "https://crm.example.test/usage",
};

describe("buildBudgetAlarmEmail", () => {
  it("usa a identidade nova como padrão e o violeta da marca", () => {
    const email = buildBudgetAlarmEmail(base);
    expect(email.subject).toContain(DEFAULT_APP_NAME);
    expect(email.html).toContain("background:#7C3AED");
    expect(email.text).toContain(DEFAULT_APP_NAME);
  });

  it("preserva nome e cor white-label resolvidos, escapando o nome no HTML", () => {
    const email = buildBudgetAlarmEmail({
      ...base,
      appName: "Clínica <Aurora>",
      accentHex: "#123abc",
    });
    expect(email.subject).toContain("Clínica <Aurora>");
    expect(email.html).toContain("Clínica &lt;Aurora&gt;");
    expect(email.html).toContain("background:#123abc");
    expect(email.html).not.toContain("background:#7C3AED");
  });

  it("recusa quebra de linha no assunto e cor que não é hexadecimal", () => {
    const nomeInjetado = `${["St", "riva"].join("")}\r\nBcc: atacante@example.test`;
    const email = buildBudgetAlarmEmail({ ...base, appName: nomeInjetado, accentHex: "red" });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).toContain("background:#7C3AED");
  });
});
