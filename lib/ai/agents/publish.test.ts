import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/ai/runtime/agent", () => ({ chaveDePlataforma: () => "test-key" }));
import { publishAgentVersion } from "./publish";

const params = { orgId: "org-a", agentId: "agent-a", versionId: "version-a" };
const rpc = vi.fn();
function client(tools: string[], pipelines: string[], operator = false) {
  const filters: Record<string, unknown> = {};
  const query = { select: () => query,
    eq: (field: string, value: string) => { filters[field] = value; return query; },
    maybeSingle: async () => {
      expect(filters).toEqual({ organization_id: params.orgId, agent_id: params.agentId, id: params.versionId });
      return { data: { provider: "openai", credential_id: null, tool_ids: operator ? [] : tools,
        operator_enabled: operator, operator_tool_ids: operator ? tools : [], pipeline_ids: pipelines }, error: null };
    } };
  return { from: () => query, rpc };
}

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: [{ agent_id: params.agentId, version_id: params.versionId,
    previous_version_id: null, published_at: "2026-09-24T12:00:00Z" }], error: null });
});

describe("publicação aplica o escopo no servidor", () => {
  it.each([false, true])("recusa escrita de funil sem escopo (Operador: %s)", async (operator) => {
    const result = await publishAgentVersion(client(["crm_move_lead_stage"], [], operator) as never, params);
    expect(result).toMatchObject({ ok: false, code: "pipeline_scope_required" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { tools: ["crm_manage_tags", "crm_book_appointment"], pipelines: [] },
    { tools: ["crm_move_lead_stage"], pipelines: ["pipeline-a"] },
  ])("preserva publicação legítima: $tools", async ({ tools, pipelines }) => {
    const result = await publishAgentVersion(client(tools, pipelines) as never, params);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("fn_publish_ai_agent_version", expect.objectContaining({ p_org_id: params.orgId }));
  });
});
