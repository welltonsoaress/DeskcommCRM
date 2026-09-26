-- 0241 — identidade estável de cada entrada em awaiting_human.
-- `updated_at` muda em qualquer edição do caso e não pode identificar um aviso:
-- polling ou atualização de título reabria o mesmo popup. Esta coluna muda só
-- quando o caso entra (ou retorna) ao estado que exige ação humana.
alter table public.agent_cases
  add column if not exists awaiting_human_at timestamptz;

update public.agent_cases
   set awaiting_human_at = coalesce(updated_at, opened_at, now())
 where status = 'awaiting_human'
   and awaiting_human_at is null;

create or replace function public.fn_agent_cases_track_human_wait()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'awaiting_human' then
    if tg_op = 'INSERT' or old.status is distinct from new.status then
      new.awaiting_human_at := clock_timestamp();
    else
      new.awaiting_human_at := coalesce(old.awaiting_human_at, new.awaiting_human_at, now());
    end if;
  else
    new.awaiting_human_at := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_agent_cases_track_human_wait() from public, anon, authenticated;

alter table public.agent_cases
  drop constraint if exists agent_cases_awaiting_human_timestamp;
alter table public.agent_cases
  add constraint agent_cases_awaiting_human_timestamp
  check (status <> 'awaiting_human' or awaiting_human_at is not null);
create index if not exists agent_cases_human_wait_idx
  on public.agent_cases (organization_id, awaiting_human_at desc)
  where status = 'awaiting_human';

drop trigger if exists trg_agent_cases_track_human_wait on public.agent_cases;
create trigger trg_agent_cases_track_human_wait
  before insert or update on public.agent_cases
  for each row execute function public.fn_agent_cases_track_human_wait();

notify pgrst, 'reload schema';
