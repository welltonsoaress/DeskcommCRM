import { describe, expect, it } from "vitest";
import { getToolByName } from "@/lib/mcp/tools";
import { MANAGEMENT_READ_TOOL_IDS } from "@/lib/management/consultation";

describe("MCP delegado ao gestor pelo WhatsApp", () => {
  it("cada ferramenta delegada é de leitura e exige apenas o escopo de leitura", () => {
    expect(MANAGEMENT_READ_TOOL_IDS.length).toBeGreaterThan(0);
    for (const id of MANAGEMENT_READ_TOOL_IDS) {
      const tool = getToolByName(id);
      expect(tool, `${id} saiu do catálogo`).toBeDefined();
      expect(tool?.category, `${id} passou a alterar dados`).toBe("read");
      expect(tool?.requiresScope, `${id} mudou de escopo`).toBe("mcp:read");
    }
  });
});
