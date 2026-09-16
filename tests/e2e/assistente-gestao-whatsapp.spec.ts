import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

test.use({ locale: "pt-BR" });

test("admin cadastra gestor e comercial; ativação aguarda número confirmado", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Somente Supabase local");
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const suffix = randomUUID().slice(0, 8);
  const email = `assistente-${suffix}@example.test`;
  const password = `E2e-${randomUUID()}!`;
  const orgName = `assistente-${suffix}`;
  execFileSync("pnpm", ["exec", "tsx", "scripts/bootstrap-owner.ts"], {
    env: { ...process.env, OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_ORG_NAME: orgName },
    stdio: "pipe",
  });
  const org = await admin.from("organizations").select("id").eq("slug", orgName).single();
  expect(org.error).toBeNull();
  const orgId = org.data!.id;
  expect((await admin.from("organizations").update({ onboarded_at: new Date().toISOString() }).eq("id", orgId)).error).toBeNull();
  const channel = await admin.from("channel_sessions").insert({
    organization_id: orgId, display_name: "Comercial de teste",
    waha_session_name: `assist_${suffix}`, webhook_secret_encrypted: "\\x00",
    status: "STOPPED",
  }).select("id").single();
  expect(channel.error).toBeNull();
  const owner = await admin.from("user_organizations").select("user_id")
    .eq("organization_id", orgId).eq("role", "admin").single();
  expect(owner.error).toBeNull();

  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/);
  await page.goto("/app/settings/management");
  await expect(page.getByRole("heading", { name: "Assistente de gestão no WhatsApp" })).toBeVisible();
  await page.getByLabel("WhatsApp comercial conectado").selectOption(channel.data!.id);
  await page.getByLabel("Usuário gestor da empresa").selectOption(owner.data!.user_id);
  await page.getByLabel("Nome do gestor").fill("Gestora de Teste");
  await page.getByLabel("WhatsApp do gestor com DDI").fill("+5511999991234");
  await page.getByRole("checkbox", { name: "Enviar resumo diário" }).check();
  await page.getByRole("button", { name: "Salvar configuração" }).click();
  await expect(page.getByRole("status")).toContainText("Configuração salva.");
  await expect(page.getByText(/Número ainda não confirmado/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Ativar consultas pelo WhatsApp" })).toBeDisabled();
  const binding = await admin.from("management_bindings").select("channel_session_id, manager_user_id, manager_name, manager_phone, enabled, verified_at, daily_enabled")
    .eq("organization_id", orgId).single();
  expect(binding.error).toBeNull();
  expect(binding.data).toMatchObject({ channel_session_id: channel.data!.id,
    manager_user_id: owner.data!.user_id, manager_name: "Gestora de Teste",
    manager_phone: "+5511999991234", enabled: false, verified_at: null, daily_enabled: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Resumo e avisos" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("assistente-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("assistente-desktop.png"), fullPage: true });
});
