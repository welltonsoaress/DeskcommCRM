import { describe, expect, it } from "vitest";
import { exigeEscopoDeFunilParaPublicar } from "./validation";

describe("exigeEscopoDeFunilParaPublicar", () => {
  const base = {
    tool_ids: [] as string[],
    operator_enabled: false,
    operator_tool_ids: [] as string[],
    pipeline_ids: [] as string[],
  };

  it("exige funil quando uma ferramenta de escrita do Conversador está ligada", () => {
    expect(exigeEscopoDeFunilParaPublicar({ ...base, tool_ids: ["crm_move_lead_stage"] })).toBe(true);
  });

  it("considera as ferramentas do Operador somente quando ele está ativo", () => {
    expect(exigeEscopoDeFunilParaPublicar({
      ...base, operator_enabled: true, operator_tool_ids: ["crm_create_lead"],
    })).toBe(true);
    expect(exigeEscopoDeFunilParaPublicar({
      ...base, operator_tool_ids: ["crm_create_lead"],
    })).toBe(false);
  });

  it("permite agenda sem funil e aceita ferramentas de escrita quando há funil configurado", () => {
    expect(exigeEscopoDeFunilParaPublicar({ ...base, tool_ids: ["crm_book_appointment"] })).toBe(false);
    expect(exigeEscopoDeFunilParaPublicar({
      ...base, tool_ids: ["crm_move_lead_stage"], pipeline_ids: ["pipeline-1"],
    })).toBe(false);
  });

  it("não exige funil para organizar marcadores de contatos e conversas", () => {
    expect(exigeEscopoDeFunilParaPublicar({ ...base, tool_ids: ["crm_manage_tags"] })).toBe(false);
    expect(exigeEscopoDeFunilParaPublicar({
      ...base, operator_enabled: true, operator_tool_ids: ["crm_manage_tags"],
    })).toBe(false);
  });
});
