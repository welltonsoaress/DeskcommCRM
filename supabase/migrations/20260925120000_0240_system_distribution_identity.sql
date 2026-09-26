-- 0240 — identidade verificável da distribuição e da release em execução.
-- Agentes antigos continuam válidos; campos vazios representam uma instalação
-- legada cuja imagem ainda não informa essa identidade.
alter table public.system_version
  add column if not exists current_distribution_id text not null default '',
  add column if not exists current_release_tag text not null default '',
  add column if not exists current_revision text not null default '',
  add column if not exists latest_release_tag text not null default '',
  add column if not exists latest_release_commit text not null default '',
  add column if not exists release_repository text not null default '';

comment on column public.system_version.current_distribution_id is
  'Identidade da distribuição reportada pelo contêiner em execução; vazio em imagens legadas.';
comment on column public.system_version.current_release_tag is
  'Tag completa e imutável da release que construiu o contêiner em execução.';
comment on column public.system_version.current_revision is
  'Commit incorporado à imagem em execução, separado do checkout atual do host.';
comment on column public.system_version.latest_release_tag is
  'Tag completa da release própria selecionada pelo agente do host.';
comment on column public.system_version.latest_release_commit is
  'Commit resolvido a partir da tag exata da release selecionada.';
comment on column public.system_version.release_repository is
  'Repositório de origem da distribuição consultado pelo agente.';
