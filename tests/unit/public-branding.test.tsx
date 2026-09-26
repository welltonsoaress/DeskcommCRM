import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { marca } = vi.hoisted(() => ({ marca: { nome: "Striva Sales" } }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => marca }));
vi.mock("@/lib/branding", () => ({ branding: () => ({ name: "Nome antigo no ambiente" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/auth/invite-token", () => ({ verifyInviteToken: () => null }));
vi.mock("@/components/auth/LoginForm", () => ({ LoginForm: () => <form aria-label="login" /> }));
vi.mock("@/components/auth/SignupForm", () => ({ SignupForm: () => <form aria-label="cadastro" /> }));

import LoginPage from "@/app/(public)/login/page";
import SignupPage from "@/app/(public)/signup/page";

afterEach(cleanup);

describe("marca das telas de acesso", () => {
  it.each(["Striva Sales", "Clínica Aurora"])("login e cadastro usam a marca resolvida %s", async (nome) => {
    marca.nome = nome;
    const login = render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(nome)).toBeVisible();
    expect(screen.queryByText("Nome antigo no ambiente")).toBeNull();
    login.unmount();
    render(await SignupPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(`Comece a usar o ${nome} em minutos`)).toBeVisible();
    expect(screen.queryByText(/Nome antigo no ambiente/)).toBeNull();
  });
});
