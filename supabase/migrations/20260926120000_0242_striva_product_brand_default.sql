-- Converte somente a marca de produto semeada pelo env padrão anterior.
-- Marcas da instalação feitas por uma pessoa (seeded_from_env=false), logos e
-- marcas por organização permanecem intactos. A auditoria acompanha a mudança.
with migrada as (
  update public.platform_branding
     set app_name = 'Striva Sales'
   where id = 1
     and seeded_from_env = true
     and app_name = 'DeskcommCRM'
     and nullif(btrim(logo_url), '') is null
     and logo_path is null
  returning id
)
insert into public.api_audit_log (
  organization_id,
  action,
  resource_type,
  metadata
)
select
  null,
  'platform_branding.product_rebrand_applied',
  'platform_branding',
  jsonb_build_object(
    'previous_name', 'DeskcommCRM',
    'current_name', 'Striva Sales',
    'source', 'distribution_migration'
  )
from migrada;
