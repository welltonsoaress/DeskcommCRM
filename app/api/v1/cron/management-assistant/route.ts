import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { createPool } from "@/lib/agent-engine/db/pool";
import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { drainManagementOutbox } from "@/lib/management/delivery";
import { recoverUncertainManagementActions } from "@/lib/management/actions";
import { managementFailureCode } from "@/lib/management/failure";
import { produceManagementReplies, produceManagementSchedule } from "@/lib/management/schedule";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cronAuthorized(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!supplied) return false;
  return [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean).some((secret) => {
    const a = Buffer.from(supplied); const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!cronAuthorized(req)) return fail("forbidden", "Cron secret invalid.", 403, { requestId });
  const admin = createAdminClient();
  const pool = createPool(env.SUPABASE_DB_URL);
  const failedStages: string[] = [];
  async function runStage<T>(stage: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      failedStages.push(stage);
      logger.error("[management] etapa do ciclo falhou", {
        request_id: requestId, stage, failure_code: managementFailureCode(error, stage),
      });
      return undefined;
    }
  }
  try {
    const actionsRecovered = await runStage("actions", () => recoverUncertainManagementActions(admin, pool));
    const replies = await runStage("replies", () => produceManagementReplies(admin, pool, 2));
    const scheduled = await runStage("schedule", () => produceManagementSchedule(admin, pool));
    // Respostas já prontas precisam sair mesmo quando outra etapa falhar.
    const deliveries = await runStage("delivery", () => drainManagementOutbox(admin, pool, 8));
    if (failedStages.length) return fail("internal_error", "Uma etapa do ciclo de gestão falhou; consulte os registros da operação.", 500,
      { requestId, details: { failed_stages: failedStages } });
    return ok({ actions_recovered: actionsRecovered, replies, ...scheduled, deliveries }, { requestId });
  } finally {
    await pool.end();
  }
}
