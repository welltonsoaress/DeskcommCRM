-- 0238: confirmação explícita de comandos do gestor, isolada por organização.
alter table public.management_bindings
  add column if not exists actions_enabled boolean not null default false;
alter table public.management_bindings
  add column if not exists weekly_enabled boolean not null default false,
  add column if not exists weekly_day integer not null default 1
    check (weekly_day between 0 and 6),
  add column if not exists weekly_hour integer not null default 9
    check (weekly_hour between 0 and 23);
alter table public.management_bindings
  drop constraint if exists management_bindings_alert_categories_check;
alter table public.management_bindings
  add constraint management_bindings_alert_categories_check
  check (alert_categories <@ array['central_critical', 'radar_critical', 'task_overdue']::text[]);
alter table public.management_outbox
  drop constraint if exists management_outbox_kind_check;
alter table public.management_outbox
  add constraint management_outbox_kind_check
  check (kind in ('verification', 'consultation', 'daily', 'weekly', 'alert'));
alter table public.management_outbox
  add column if not exists body_encrypted boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'management_messages_org_id_unique') then
    alter table public.management_messages
      add constraint management_messages_org_id_unique unique (organization_id, id);
  end if;
end $$;

create table if not exists public.management_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null,
  manager_user_id uuid not null references auth.users(id) on delete restrict,
  source_message_id uuid not null,
  action text not null check (action in ('move_lead_stage', 'create_task', 'book_appointment', 'request_appointment', 'assign_conversation', 'pause_attendance', 'resume_attendance')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  code_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'executing', 'completed', 'failed', 'uncertain', 'cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  error_code text,
  result_body text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source_message_id),
  constraint management_actions_org_session_fk
    foreign key (organization_id, channel_session_id)
    references public.channel_sessions(organization_id, id) on delete restrict,
  constraint management_actions_org_message_fk
    foreign key (organization_id, source_message_id)
    references public.management_messages(organization_id, id) on delete cascade
);
create index if not exists management_actions_pending_idx
  on public.management_actions (organization_id, channel_session_id, created_at desc)
  where status = 'pending';
create unique index if not exists management_actions_code_unique
  on public.management_actions (organization_id, channel_session_id, manager_user_id, code_hash);
alter table public.management_actions enable row level security;
revoke all on public.management_actions from anon, authenticated;
grant select on public.management_actions to authenticated;
drop policy if exists tenant_isolation_management_actions_select on public.management_actions;
create policy tenant_isolation_management_actions_select on public.management_actions
  for select to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );
drop trigger if exists trg_management_actions_updated_at on public.management_actions;
create trigger trg_management_actions_updated_at before update on public.management_actions
  for each row execute function public.fn_set_updated_at();
notify pgrst, 'reload schema';
