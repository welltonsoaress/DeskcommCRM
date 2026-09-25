export interface ManagementInboundStateInput {
  kind: string;
  claim_until: string | null;
  reply: { status: string; error_code: string | null; delivered_at?: string | null; read_at?: string | null } | null;
  processingFailure: boolean;
}

export interface ManagementInboundState {
  status: string;
  error_code: string | null;
}

/** Estado operacional derivado da pergunta, da outbox e do aviso ligado a ela. */
export function managementInboundState(input: ManagementInboundStateInput, now = Date.now()): ManagementInboundState {
  if (input.reply) return {
    status: input.reply.error_code === "provider_delivery_failed" ? "failed"
      : input.reply.read_at ? "read" : input.reply.delivered_at ? "delivered"
      : input.reply.status === "pending" ? "waiting_delivery" : input.reply.status,
    error_code: input.reply.error_code ?? (input.processingFailure ? "processing_failed" : null),
  };
  if (input.processingFailure) return {
    status: input.kind === "ignored" ? "failed" : "retry_pending", error_code: "processing_failed",
  };
  if (input.kind === "ignored") return { status: "ignored", error_code: null };
  const lease = input.claim_until ? Date.parse(input.claim_until) : Number.NaN;
  if (Number.isFinite(lease) && lease > now) return { status: "processing", error_code: null };
  return { status: "pending", error_code: null };
}
