import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { createPool } from "@/lib/agent-engine/db/pool";
import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { drainManagementOutbox } from "@/lib/management/delivery";
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
  let stage = "replies";
  try {
    const replies = await produceManagementReplies(admin, pool, 2);
    stage = "schedule";
    const scheduled = await produceManagementSchedule(admin, pool);
    stage = "delivery";
    const deliveries = await drainManagementOutbox(admin, pool, 8);
    return ok({ replies, ...scheduled, deliveries }, { requestId });
  } catch {
    logger.error("[management] ciclo falhou", { request_id: requestId, stage });
    return fail("internal_error", "O ciclo de gestão falhou; veja os avisos da operação.", 500, { requestId });
  } finally {
    await pool.end();
  }
}
