#!/usr/bin/env bash
# Testa a transformação de crons sem Docker, crontab real ou arquivos de VPS.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
MIGRAR_DIRETORIO_LIB=1 source ./migrar-diretorio.sh

antiga=/var/www/DeskcommCRM
nova=/var/www/striva-sales
url=https://crm.exemplo.com.br
secret=segredo-da-instalacao
crons="$(cat <<EOF
0 8 * * * /opt/backup/other-instance.sh
* * * * * curl -fsS -H \"Authorization: Bearer ${secret}\" \"${url}/api/v1/cron/event-log-drain\" >/dev/null 2>&1 # deskcomm:${antiga}:drain
*/5 * * * * cd ${antiga} && bash hostgator-setup-kit/agent.sh >/dev/null 2>&1 # deskcomm:${antiga}:agent
* * * * * curl -fsS -H \"Authorization: Bearer ${secret}\" \"${url}/api/v1/cron/event-log-drain\" >/dev/null 2>&1
*/5 * * * * cd ${antiga} && bash hostgator-setup-kit/agent.sh >/dev/null 2>&1
* * * * * curl -fsS -H \"Authorization: Bearer vizinho\" \"https://outro.exemplo.com.br/api/v1/cron/event-log-drain\" >/dev/null 2>&1 # deskcomm:/opt/outro:drain
EOF
)"
resultado="$(printf '%s\n' "$crons" | cron_reescrever_diretorio "$antiga" "$nova" "$url" "$secret")"

falhas=0
verificar() {
  local descricao="$1" condicao="$2"
  if eval "$condicao"; then printf '  ✓ %s\n' "$descricao"
  else printf '  ✗ %s\n' "$descricao"; falhas=1; fi
}
verificar "cron de backup alheio preservado" "printf '%s' \"\$resultado\" | grep -qF '/opt/backup/other-instance.sh'"
verificar "agente aponta para a nova pasta" "printf '%s' \"\$resultado\" | grep -qF 'cd /var/www/striva-sales && bash hostgator-setup-kit/agent.sh'"
verificar "marcador do agente usa o novo caminho" "printf '%s' \"\$resultado\" | grep -qF '# deskcomm:/var/www/striva-sales:agent'"
verificar "drain legado fica marcado na instalação certa" "printf '%s' \"\$resultado\" | grep -qF '# deskcomm:/var/www/striva-sales:drain'"
verificar "nenhum marcador aponta para o diretório antigo" "! printf '%s' \"\$resultado\" | grep -qF '$antiga'"
verificar "duas linhas de agente deduplicadas" "[ \$(printf '%s' \"\$resultado\" | grep -cF 'hostgator-setup-kit/agent.sh') -eq 1 ]"
verificar "duas linhas de drain deduplicadas" "[ \$(printf '%s' \"\$resultado\" | grep -cF 'crm.exemplo.com.br/api/v1/cron/event-log-drain') -eq 1 ]"
verificar "cron de outra instalação e credencial preservado" "printf '%s' \"\$resultado\" | grep -qF 'Bearer vizinho'"

[ "$falhas" -eq 0 ]

echo "migração da pasta em fixture isolada"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    # Windows mantém o handle de flock aberto e impede mover a pasta que o
    # contém. A operação de produção roda em Linux; as regras puras acima
    # continuam cobertas aqui e a migração completa roda no CI Linux.
    printf '  ↷ move real ignorado no Git Bash (lock aberto impede rename de diretório)\n'
    exit 0
    ;;
esac
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
antiga="$fixture/DeskcommCRM"
nova="$fixture/striva-sales"
bin="$fixture/bin"
mkdir -p "$antiga/hostgator-setup-kit" "$bin" "$antiga/backups"
cp ./_common.sh ./distribution.env ./migrar-diretorio.sh "$antiga/hostgator-setup-kit/"
printf 'APP_NAME="CRM da empresa"\nNEXT_PUBLIC_APP_URL="https://crm.exemplo.com.br"\nINTERNAL_SECRET="segredo-da-instalacao"\n' > "$antiga/.env"
printf 'compose fixture\n' > "$antiga/docker-compose.prod.yml"
printf 'backup preservado\n' > "$antiga/backups/antes.tar.gz"
cat > "$bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'compose-legado\n'
EOF
cat > "$bin/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$bin/crontab" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -l ]; then cat "$CRONTAB_STATE"; exit 0; fi
cat "$1" > "$CRONTAB_STATE"
EOF
chmod +x "$bin/docker" "$bin/flock" "$bin/crontab"
printf '0 8 * * * /opt/backup/other-instance.sh\n*/5 * * * * cd %s && bash hostgator-setup-kit/agent.sh >/dev/null 2>&1\n' \
  "$antiga" > "$fixture/crontab"
CRONTAB_STATE="$fixture/crontab" PATH="$bin:$PATH" \
  bash "$antiga/hostgator-setup-kit/migrar-diretorio.sh" "$nova" >/dev/null

verificar "pasta antiga movida e destino criado" "[ ! -e '$antiga' ] && [ -f '$nova/.env' ]"
verificar "identidade Compose dos volumes fixada antes do move" "grep -qx 'COMPOSE_PROJECT_NAME=compose-legado' '$nova/.env'"
verificar "backup contido acompanhou o diretório" "grep -qF 'backup preservado' '$nova/backups/antes.tar.gz'"
verificar "cron agora aponta para o destino" "grep -qF 'cd $nova && bash hostgator-setup-kit/agent.sh' '$fixture/crontab'"
verificar "cron de outra instalação sobreviveu ao move" "grep -qF '/opt/backup/other-instance.sh' '$fixture/crontab'"
[ "$falhas" -eq 0 ]
