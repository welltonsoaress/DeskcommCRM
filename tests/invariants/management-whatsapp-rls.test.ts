import { beforeAll, describe, expect, it } from "vitest";
import { countAs, sql, writeCountAs } from "./gov-helpers";

/** JWT reais simulados na Data API; não conta como superusuário. */
const A = "0237aaaa-0000-4000-8000-000000000001";
const B = "0237bbbb-0000-4000-8000-000000000002";
const ADMIN_A = "0237aaaa-1111-4000-8000-000000000001";
const ADMIN_B = "0237bbbb-1111-4000-8000-000000000002";
const VIEWER_A = "0237aaaa-1111-4000-8000-000000000003";
const SESSION_A = "0237aaaa-2222-4000-8000-000000000001";
const SESSION_B = "0237bbbb-2222-4000-8000-000000000002";
const TABLES = ["management_bindings", "management_messages", "management_outbox"] as const;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}', 'management-a@invariant.test'),
      ('${ADMIN_B}', 'management-b@invariant.test'),
      ('${VIEWER_A}', 'management-viewer@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${A}', 'management-inv-a', 'Management Invariant A', 'Management A'),
      ('${B}', 'management-inv-b', 'Management Invariant B', 'Management B') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}', '${A}', 'admin', now()),
      ('${ADMIN_B}', '${B}', 'admin', now()),
      ('${VIEWER_A}', '${A}', 'viewer', now()) on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESSION_A}', '${A}', 'management-inv-a', '\\x00'::bytea),
      ('${SESSION_B}', '${B}', 'management-inv-b', '\\x00'::bytea) on conflict (id) do nothing;
    insert into public.management_bindings
      (organization_id, channel_session_id, manager_user_id, manager_name, manager_phone, verified_at, enabled)
      values ('${A}', '${SESSION_A}', '${ADMIN_A}', 'Manager A', '+5511999990001', now(), true),
             ('${B}', '${SESSION_B}', '${ADMIN_B}', 'Manager B', '+5511999990002', now(), true)
      on conflict (organization_id) do nothing;
    insert into public.management_messages
      (organization_id, channel_session_id, external_id, direction, kind, body)
      values ('${A}', '${SESSION_A}', 'management-inv-a', 'inbound', 'consultation', 'private A'),
             ('${B}', '${SESSION_B}', 'management-inv-b', 'inbound', 'consultation', 'private B')
      on conflict do nothing;
    insert into public.management_outbox
      (organization_id, channel_session_id, kind, dedupe_key, body)
      values ('${A}', '${SESSION_A}', 'consultation', 'management-inv-a', 'private A'),
             ('${B}', '${SESSION_B}', 'consultation', 'management-inv-b', 'private B')
      on conflict do nothing;
  `);
});

describe("0237: dados do gestor pertencem à empresa e ao administrador", () => {
  it.each(TABLES)("%s: admin local lê, admin vizinho e viewer local não leem", (table) => {
    expect(countAs(ADMIN_A, `select count(*) from public.${table} where organization_id = '${A}'`)).toBeGreaterThan(0);
    expect(countAs(ADMIN_B, `select count(*) from public.${table} where organization_id = '${A}'`)).toBe(0);
    expect(countAs(ADMIN_A, `select count(*) from public.${table} where organization_id = '${B}'`)).toBe(0);
    expect(countAs(VIEWER_A, `select count(*) from public.${table} where organization_id = '${A}'`)).toBe(0);
  });

  it("admin A consegue gravar consulta em A e não consegue gravar em B", () => {
    expect(writeCountAs(ADMIN_A, `insert into public.management_messages
      (organization_id, channel_session_id, external_id, direction, kind, body)
      values ('${A}', '${SESSION_A}', 'management-positive', 'inbound', 'consultation', 'own')`)).toBe(1);
    expect(writeCountAs(ADMIN_A, `insert into public.management_messages
      (organization_id, channel_session_id, external_id, direction, kind, body)
      values ('${B}', '${SESSION_B}', 'management-cross', 'inbound', 'consultation', 'cross')`)).toBe(0);
    expect(sql("select count(*) from public.management_messages where external_id = 'management-cross'")).toBe("0");
  });

  it("FK composta impede ligar a empresa A ao comercial B", () => {
    let error = "";
    try {
      sql(`update public.management_bindings set channel_session_id = '${SESSION_B}' where organization_id = '${A}'`);
    } catch (caught) {
      error = String((caught as { stderr?: string }).stderr ?? caught);
    }
    expect(error).toContain("management_bindings_org_session_fk");
  });

  it("anon não tem acesso às três tabelas", () => {
    for (const table of TABLES)
      expect(sql(`select has_table_privilege('anon', 'public.${table}', 'SELECT')`)).toBe("f");
  });
});
