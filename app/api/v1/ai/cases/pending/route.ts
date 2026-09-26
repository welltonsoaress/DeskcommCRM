import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** IDs e horários apenas: o alerta não precisa ler dados pessoais do contato. */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_cases_pending" });
  if (!authz.ok) return authz.response;

  const { data: rows, error } = await createAdminClient()
    .from("agent_cases")
    // O tipo gerado acompanha a migration pelo fluxo do projeto, que não está
    // disponível neste ambiente. A seleção continua explícita e minimizada.
    .select("id, opened_at, awaiting_human_at" as never)
    .eq("organization_id", authz.org.orgId)
    .eq("status", "awaiting_human")
    .order("awaiting_human_at", { ascending: false });

  if (error) {
    return fail("internal_error", "Falha ao carregar os casos pendentes.", 500, { requestId });
  }
  const data = (rows ?? []) as unknown as Array<{
    id: string;
    opened_at: string;
    awaiting_human_at: string;
  }>;
  return ok({ pending_cases: data, pending_count: data.length }, { requestId });
}
