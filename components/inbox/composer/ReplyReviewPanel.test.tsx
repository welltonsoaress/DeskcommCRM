import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, postMock, showApiErrorMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  showApiErrorMock: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({ apiClient: { get: getMock, post: postMock } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: showApiErrorMock }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1" } }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

import { ReplyReviewPanel } from "./ReplyReviewPanel";

const draft = {
  id: "draft-1",
  revision: "revision-1",
  status: "pending",
  original_body: "Olá, posso ajudar?",
  edited_body: null,
  error_code: null,
  proposals: [],
};

function renderPanel(conversationId = "conversation-1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ReplyReviewPanel conversationId={conversationId} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe("ReplyReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: { drafts: [draft] } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("começa compacto, fecha sem descartar e continua fechado após atualizar a consulta", async () => {
    const { queryClient } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Ver sugestão" }));
    const editor = await screen.findByRole("textbox", { name: "Resposta sugerida" });
    fireEvent.change(editor, { target: { value: "Texto revisado pela pessoa" } });

    fireEvent.click(screen.getByRole("button", { name: "Fechar sugestão" }));
    expect(screen.queryByRole("textbox", { name: "Resposta sugerida" })).toBeNull();

    await queryClient.invalidateQueries({ queryKey: ["reply-drafts", "org-1", "conversation-1"] });
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("textbox", { name: "Resposta sugerida" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ver sugestão" }));
    expect(screen.getByRole("textbox", { name: "Resposta sugerida" })).toHaveValue(
      "Texto revisado pela pessoa",
    );
  });

  it("recolhe após o servidor aceitar a aprovação", async () => {
    postMock.mockResolvedValue({ data: {} });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Ver sugestão" }));
    const editor = await screen.findByRole("textbox", { name: "Resposta sugerida" });
    fireEvent.change(editor, { target: { value: "Resposta aprovada" } });

    fireEvent.click(screen.getByRole("button", { name: "Aprovar e enviar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ver sugestão" })).toBeTruthy());
    expect(screen.queryByRole("textbox", { name: "Resposta sugerida" })).toBeNull();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith("/api/v1/ai/replies/draft-1", {
      action: "approve",
      revision: "revision-1",
      body: "Resposta aprovada",
      feedback: "",
    });
  });

  it.each(["sent", "dismissed", "stale"])("permite gerar outra sugestão após %s", async (status) => {
    getMock.mockResolvedValue({ data: { drafts: [{ ...draft, status }] } });
    postMock.mockResolvedValue({ data: {} });
    renderPanel();
    await screen.findByText(status === "sent" ? "Resposta aprovada enviada" :
      status === "dismissed" ? "Sugestão rejeitada" : "Sugestão obsoleta: a conversa mudou");
    fireEvent.click(screen.getByRole("button", { name: "Sugerir resposta" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      "/api/v1/conversations/conversation-1/draft-reply", {},
    ));
  });

  it("em falha mantém painel e edição para recuperação", async () => {
    postMock.mockRejectedValue(new Error("falha simulada"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Ver sugestão" }));
    const editor = await screen.findByRole("textbox", { name: "Resposta sugerida" });
    fireEvent.change(editor, { target: { value: "Edição preservada" } });

    fireEvent.click(screen.getByRole("button", { name: "Aprovar e enviar" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sua edição foi preservada");
    expect(screen.getByRole("textbox", { name: "Resposta sugerida" })).toHaveValue(
      "Edição preservada",
    );
    expect(showApiErrorMock).toHaveBeenCalledTimes(1);
  });

  it("limpa a edição e recolhe ao trocar de conversa", async () => {
    const getForConversation = (url: string) => ({
      data: {
        drafts: [
          {
            ...draft,
            id: url.includes("conversation-2") ? "draft-2" : "draft-1",
            original_body: url.includes("conversation-2") ? "Outra conversa" : draft.original_body,
          },
        ],
      },
    });
    getMock.mockImplementation(async (url: string) => getForConversation(url));
    const view = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Ver sugestão" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Resposta sugerida" }), {
      target: { value: "Não deve atravessar conversa" },
    });

    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <ReplyReviewPanel conversationId="conversation-2" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations/conversation-2/draft-reply"));
    fireEvent.click(await screen.findByRole("button", { name: "Ver sugestão" }));
    expect(await screen.findByRole("textbox", { name: "Resposta sugerida" })).toHaveValue(
      "Outra conversa",
    );
  });
});
