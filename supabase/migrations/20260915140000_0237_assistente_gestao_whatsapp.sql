-- 0237: assistente de gestão, desligado por ausência de vínculo.
-- Cadastro e identidade ficam isolados do funil comercial. O service role
-- precisa filtrar organization_id em cada operação; as policies abaixo são
-- defesa adicional para a Data API.

create table if not exists public.management_bindings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  channel_session_id uuid not null,
  manager_user_id uuid not null references auth.users(id) on delete restrict,
  manager_name text not null check (length(trim(manager_name)) between 1 and 120),
  manager_phone text not null check (manager_phone ~ '^\+[1-9][0-9]{7,14}$'),
  enabled boolean not null default false,
  verified_at timestamptz,
  challenge_hash text,
  challenge_expires_at timestamptz,
  challenge_attempts integer not null default 0 check (challenge_attempts between 0 and 5),
  daily_enabled boolean not null default false,
  daily_hour integer not null default 9 check (daily_hour between 0 and 23),
  alerts_enabled boolean not null default false,
  alert_categories text[] not null default '{}'::text[]
    check (alert_categories <@ array['central_critical', 'radar_critical']::text[]),
  max_daily_alerts integer not null default 3 check (max_daily_alerts between 0 and 20),
  paused_at timestamptz,
  configured_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint management_bindings_verified_enabled check (not enabled or verified_at is not null)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'management_bindings_org_session_fk') then
    alter table public.management_bindings add constraint management_bindings_org_session_fk
      foreign key (organization_id, channel_session_id)
      references public.channel_sessions(organization_id, id) on delete restrict;
  end if;
end $$;

create table if not exists public.management_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null,
  external_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  kind text not null default 'consultation' check (kind in ('verification', 'consultation', 'pause', 'ignored')),
  body text,
  claim_until timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, channel_session_id, external_id, direction)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'management_messages_org_session_fk') then
    alter table public.management_messages add constraint management_messages_org_session_fk
      foreign key (organization_id, channel_session_id)
      references public.channel_sessions(organization_id, id) on delete restrict;
  end if;
end $$;

create table if not exists public.management_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null,
  kind text not null check (kind in ('verification', 'consultation', 'daily', 'alert')),
  dedupe_key text not null,
  body text not null,
  verification_hash text,
  alert_source text,
  reference_id uuid,
  status text not null default 'pending' check (status in ('pending', 'sending', 'accepted', 'failed', 'uncertain', 'cancelled')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  external_id text,
  delivered_at timestamptz,
  read_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, dedupe_key)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'management_outbox_org_session_fk') then
    alter table public.management_outbox add constraint management_outbox_org_session_fk
      foreign key (organization_id, channel_session_id)
      references public.channel_sessions(organization_id, id) on delete restrict;
  end if;
end $$;

create index if not exists management_outbox_pending_idx
  on public.management_outbox (created_at) where status = 'pending';
create index if not exists management_messages_recent_idx
  on public.management_messages (organization_id, created_at desc);

alter table public.management_bindings enable row level security;
alter table public.management_messages enable row level security;
alter table public.management_outbox enable row level security;

revoke all on public.management_bindings, public.management_messages, public.management_outbox from anon, authenticated;
grant select, insert, update, delete on public.management_bindings, public.management_messages, public.management_outbox to authenticated;

drop policy if exists tenant_isolation_management_bindings_all on public.management_bindings;
create policy tenant_isolation_management_bindings_all on public.management_bindings
  for all to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );
drop policy if exists tenant_isolation_management_messages_all on public.management_messages;
create policy tenant_isolation_management_messages_all on public.management_messages
  for all to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );
drop policy if exists tenant_isolation_management_outbox_all on public.management_outbox;
create policy tenant_isolation_management_outbox_all on public.management_outbox
  for all to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

drop trigger if exists trg_management_bindings_updated_at on public.management_bindings;
create trigger trg_management_bindings_updated_at before update on public.management_bindings
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_management_outbox_updated_at on public.management_outbox;
create trigger trg_management_outbox_updated_at before update on public.management_outbox
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
