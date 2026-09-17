---
impacto: capacidade_nova
secao: alterado
titulo: Instalações novas usam o repositório e as imagens deste fork
---

O kit de instalação, o compose de produção e a documentação de deploy apontam
para `welltonsoaress/DeskcommCRM` e para as três imagens publicadas em
`ghcr.io/welltonsoaress`. Instalações já existentes não mudam automaticamente:
as referências gravadas no `.env` da VPS precisam ser avaliadas antes de uma
migração. A telemetria herdada fica desligada por padrão; para monitorar erros,
configure o DSN da sua própria conta Sentry.
