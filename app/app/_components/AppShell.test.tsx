import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", support: false },
    activeOrg: { orgId: "org-1", role: "agent" },
  },
  pending: {
    isSuccess: true,
    data: { pending_cases: [] as Array<{ id: string; opened_at: string; awaiting_human_at: string }>, pending_count: 0 },
  },
  onRealtimeChange: null as ((payload: unknown) => void) | null,
  invalidateQueries: vi.fn(),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/hooks/ai/useCases", () => ({ usePendingCases: () => mocks.pending }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }) }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (options: { onChange: (payload: unknown) => void }) => {
    mocks.onRealtimeChange = options.onChange;
  },
}));
vi.mock("@/hooks/notifications/useInboundMessageAlerts", () => ({ useInboundMessageAlerts: vi.fn() }));
vi.mock("@/hooks/notifications/useCrmAlerts", () => ({ useCrmAlerts: vi.fn() }));
vi.mock("@/lib/notifications/notify_open", () => ({ useNotifyOpenFromServiceWorker: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("@/components/shell/Sidebar", () => ({
  Sidebar: ({ pendingCasesCount }: { pendingCasesCount: number }) => (
    <output data-testid="sidebar-pending-count">{pendingCasesCount}</output>
  ),
}));
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => <header /> }));
vi.mock("@/lib/ui/icons", () => ({ X: () => <svg aria-hidden="true" /> }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { AppShell } from "./AppShell";

const CASO_1 = {
  id: "case-1",
  opened_at: "2026-09-26T12:00:00.000Z",
  awaiting_human_at: "2026-09-26T12:01:00.000Z",
};

function pendencias(rows: typeof CASO_1[]) {
  mocks.pending = {
    isSuccess: true,
    data: { pending_cases: rows, pending_count: rows.length },
  };
}

function evento(
  eventType: "INSERT" | "UPDATE",
  next: Record<string, unknown>,
  old: Record<string, unknown> = {},
) {
  return { eventType, new: next, old };
}

beforeEach(() => {
  localStorage.clear();
  mocks.auth = {
    user: { id: "user-1", support: false },
    activeOrg: { orgId: "org-1", role: "agent" },
  };
  pendencias([]);
  mocks.onRealtimeChange = null;
  mocks.invalidateQueries.mockClear();
});

afterEach(cleanup);

describe("avisos de casos na navegação", () => {
  it("mostra as pendências existentes, fecha sem resolvê-las e não repete a mesma ocorrência", async () => {
    pendencias([CASO_1]);
    render(<AppShell sidebarCollapsed={false}><p>Inbox</p></AppShell>);

    expect(screen.getByText("Há casos aguardando ação humana")).toBeTruthy();
    expect(screen.getByTestId("sidebar-pending-count").textContent).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Fechar aviso" }));
    expect(screen.queryByText("Há casos aguardando ação humana")).toBeNull();

    await act(async () => {
      mocks.onRealtimeChange?.(evento("INSERT", { ...CASO_1, status: "awaiting_human" }));
    });
    expect(screen.queryByText("Há casos aguardando ação humana")).toBeNull();
    expect(JSON.parse(localStorage.getItem("casos-aviso:user-1:org-1") ?? "[]")).toContain(
      `${CASO_1.id}:${CASO_1.awaiting_human_at}`,
    );
  });

  it("ignora awaiting_lead, avisa no retorno ao humano e recolhe o aviso quando o caso resolve", async () => {
    render(<AppShell sidebarCollapsed={false}><p>Inbox</p></AppShell>);
    await act(async () => {
      mocks.onRealtimeChange?.(evento("INSERT", {
        ...CASO_1,
        status: "awaiting_lead",
      }));
    });
    expect(screen.queryByText("Há casos aguardando ação humana")).toBeNull();

    await act(async () => {
      mocks.onRealtimeChange?.(evento("UPDATE", {
        ...CASO_1,
        status: "awaiting_human",
      }, { id: CASO_1.id, status: "awaiting_lead" }));
    });
    expect(screen.getByText("Há casos aguardando ação humana")).toBeTruthy();

    await act(async () => {
      mocks.onRealtimeChange?.(evento("UPDATE", {
        ...CASO_1,
        status: "resolved",
      }, { id: CASO_1.id, status: "awaiting_human" }));
    });
    expect(screen.queryByText("Há casos aguardando ação humana")).toBeNull();
  });

  it("não leva o aviso nem a contagem para outra organização", () => {
    pendencias([CASO_1]);
    const view = render(<AppShell sidebarCollapsed={false}><p>Inbox</p></AppShell>);
    expect(screen.getByText("Há casos aguardando ação humana")).toBeTruthy();

    mocks.auth = {
      user: { id: "user-1", support: false },
      activeOrg: { orgId: "org-2", role: "agent" },
    };
    pendencias([]);
    view.rerender(<AppShell sidebarCollapsed={false}><p>Inbox</p></AppShell>);

    expect(screen.queryByText("Há casos aguardando ação humana")).toBeNull();
    expect(screen.getByTestId("sidebar-pending-count").textContent).toBe("0");
  });
});
