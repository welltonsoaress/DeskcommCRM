-- Casos aguardando ação humana precisam aparecer sem recarregar a tela.
--
-- O cliente assina com filtro por organization_id e reconsulta uma rota
-- autenticada que retorna somente identificadores e horários. `awaiting_lead`
-- não gera alerta de ação humana. Idempotente para instalações existentes.
do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'agent_cases'
  ) then
    execute 'alter publication supabase_realtime add table public.agent_cases';
  end if;
end $$;
