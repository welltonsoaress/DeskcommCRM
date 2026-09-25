import { describe, expect, it } from "vitest";

import { managementInboundState } from "@/lib/management/history";

describe("estado da pergunta recebida pelo Assistente de gestão", () => {
  it("mostra pendente quando ainda não há resposta nem claim vigente", () => {
    expect(managementInboundState({ kind: "consultation", claim_until: null, reply: null,
      processingFailure: false }, 1_000)).toEqual({ status: "pending", error_code: null });
  });

  it("mostra em processamento durante o lease", () => {
    expect(managementInboundState({ kind: "consultation", claim_until: new Date(2_000).toISOString(),
      reply: null, processingFailure: false }, 1_000)).toEqual({ status: "processing", error_code: null });
  });

  it("prioriza a falha de processamento e preserva o estado de envio quando há resposta", () => {
    expect(managementInboundState({ kind: "ignored", claim_until: null, reply: null,
      processingFailure: true })).toEqual({ status: "failed", error_code: "processing_failed" });
    expect(managementInboundState({ kind: "consultation", claim_until: null,
      reply: { status: "accepted", error_code: null }, processingFailure: false }))
      .toEqual({ status: "accepted", error_code: null });
  });

  it("distingue fila de envio de pergunta que ainda precisa ser processada", () => {
    expect(managementInboundState({ kind: "consultation", claim_until: null,
      reply: { status: "pending", error_code: null }, processingFailure: false }))
      .toEqual({ status: "waiting_delivery", error_code: null });
    expect(managementInboundState({ kind: "consultation", claim_until: null,
      reply: null, processingFailure: true }))
      .toEqual({ status: "retry_pending", error_code: "processing_failed" });
  });

  it("enviar a resposta de contingência não esconde a falha ao preparar o resumo", () => {
    expect(managementInboundState({ kind: "consultation", claim_until: null,
      reply: { status: "accepted", error_code: null, delivered_at: "2026-09-24T12:00:00Z" }, processingFailure: true }))
      .toEqual({ status: "delivered", error_code: "processing_failed" });
  });

  it("não apresenta recibo antigo como sucesso quando o canal registrou falha de entrega", () => {
    expect(managementInboundState({ kind: "consultation", claim_until: null,
      reply: { status: "failed", error_code: "provider_delivery_failed", read_at: "2026-09-24T12:00:00Z" }, processingFailure: false }))
      .toEqual({ status: "failed", error_code: "provider_delivery_failed" });
  });
});
