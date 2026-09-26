#!/usr/bin/env bash
# Guards for the Striva-only release path. Everything runs in a disposable
# checkout with HTTP, Docker and cron replaced by local doubles.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REAL_GIT="$(command -v git)"
FAILS=0
check() { local description="$1"; shift; if "$@"; then printf '  ✓ %s\n' "$description"; else printf '  ✗ %s\n' "$description"; FAILS=$((FAILS+1)); fi; }

mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'CURL'
#!/usr/bin/env bash
url="${!#}"
case "$url" in
  *api.github.com/repos/welltonsoaress/striva-sales/releases\?per_page=100*)
    [ "${NETWORK_DOWN:-0}" = 1 ] && exit 22
    printf '[{"tag_name":"striva-v1.0.0","draft":false,"prerelease":false},{"tag_name":"striva-v1.2.0","draft":false,"prerelease":false},{"tag_name":"striva-v1.9.0-rc.1","draft":false,"prerelease":true},{"tag_name":"striva-v9.0.0","draft":true,"prerelease":false},{"tag_name":"v99.0.0","draft":false,"prerelease":false}]'
    ;;
  *api.github.com/repos/welltonsoaress/striva-sales/releases/tags/striva-v1.2.0)
    printf '{"tag_name":"striva-v1.2.0","draft":false,"prerelease":false}'
    ;;
  *api.github.com/repos/welltonsoaress/striva-sales/releases/tags/striva-v9.0.0)
    printf '{"tag_name":"striva-v9.0.0","draft":true,"prerelease":false}'
    ;;
  *api.github.com/repos/welltonsoaress/striva-sales/releases/tags/v99.0.0)
    printf '{"tag_name":"v99.0.0","draft":false,"prerelease":false}'
    ;;
  *ghcr.io/token\?*) printf '{"token":"local-test"}' ;;
  *ghcr.io/v2/*/manifests/*)
    case "$url" in *"/${MISSING_IMAGE:-none}/manifests/"*) printf '404' ;; *) printf '200' ;; esac
    ;;
  *) exit 22 ;;
esac
CURL
cat > "$WORK/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
# No running Compose project in the isolated test.
exit 0
DOCKER
cat > "$WORK/bin/crontab" <<'CRON'
#!/usr/bin/env bash
[ "${1:-}" = -l ] && { [ -f "$CRON_FILE" ] && cat "$CRON_FILE"; exit 0; }
[ "${1:-}" = - ] && { cat > "$CRON_FILE"; exit 0; }
exit 0
CRON
if [ -n "${PYTHON3_BIN:-}" ]; then
  cat > "$WORK/bin/python3" <<'PYTHON'
#!/usr/bin/env bash
exec "$PYTHON3_BIN" "$@"
PYTHON
  chmod +x "$WORK/bin/python3"
fi
chmod +x "$WORK/bin/curl" "$WORK/bin/docker" "$WORK/bin/crontab"
export PATH="$WORK/bin:$PATH" DOCKER_LOG="$WORK/docker.log" CRON_FILE="$WORK/crontab"

# The source must scope both release metadata and image probes to the new contract.
source "$KIT/_common.sh"
check "distribution identity is Striva" test "$DISTRIBUTION_ID" = striva-sales
check "repository and image names come from the distribution contract" test "$IMG_APP" = ghcr.io/welltonsoaress/striva-sales
check "highest stable Striva release ignores generic, draft and prerelease tags" test "$(tag_da_release_mais_recente)" = striva-v1.2.0
check "published release is validated by exact tag in this repository" release_publicada striva-v1.2.0
if release_publicada striva-v9.0.0; then echo '  ✗ draft was accepted'; FAILS=$((FAILS+1)); else echo '  ✓ draft release rejected'; fi
if release_publicada v99.0.0; then echo '  ✗ inherited generic tag was accepted'; FAILS=$((FAILS+1)); else echo '  ✓ generic inherited tag rejected'; fi
check "last version is exposed only while all three images exist" test "$(ultima_versao_publicada)" = 1.2.0
MISSING_IMAGE=striva-worker
export MISSING_IMAGE
if [ -n "$(ultima_versao_publicada)" ]; then echo '  ✗ release with missing image was advertised'; FAILS=$((FAILS+1)); else echo '  ✓ a missing image leaves the release unavailable'; fi
unset MISSING_IMAGE

# No network response is not evidence that the system is current.
NETWORK_DOWN=1
export NETWORK_DOWN
if [ -n "$(tag_da_release_mais_recente || true)" ]; then echo '  ✗ failed GitHub lookup returned a release'; FAILS=$((FAILS+1)); else echo '  ✓ GitHub outage yields no update candidate'; fi
unset NETWORK_DOWN

# A local clone of the old project can contain colliding generic tags. The
# private release ref must resolve from the configured Striva remote only.
REMOTE="$WORK/striva.git"
SEED="$WORK/seed"
LOCAL="$WORK/local"
mkdir -p "$SEED" "$LOCAL"
git -C "$SEED" init --bare --quiet
git -C "$WORK" init "$LOCAL" --quiet
git -C "$LOCAL" config user.email test@example.invalid
git -C "$LOCAL" config user.name test
printf 'own release\n' > "$LOCAL/own.txt"
git -C "$LOCAL" add own.txt
git -C "$LOCAL" commit --quiet -m 'Striva release'
git -C "$LOCAL" tag striva-v1.0.0
OWN_COMMIT="$(git -C "$LOCAL" rev-parse HEAD)"
git -C "$LOCAL" push --quiet "$SEED" HEAD:refs/heads/main refs/tags/striva-v1.0.0
printf 'contaminated tag\n' > "$LOCAL/contaminated.txt"
git -C "$LOCAL" add contaminated.txt
git -C "$LOCAL" commit --quiet -m 'legacy checkout'
git -C "$LOCAL" tag -f striva-v1.0.0 >/dev/null
CONTAMINATED_TAG_COMMIT="$(git -C "$LOCAL" rev-parse striva-v1.0.0)"
git -C "$LOCAL" tag v99.0.0
cat > "$WORK/bin/git" <<'GIT'
#!/usr/bin/env bash
args=()
for arg in "$@"; do
  [ "$arg" = "https://github.com/welltonsoaress/striva-sales.git" ] && arg="$STRIVA_REMOTE"
  args+=("$arg")
done
exec "$REAL_GIT" "${args[@]}"
GIT
chmod +x "$WORK/bin/git"
export REAL_GIT STRIVA_REMOTE="$SEED"
hash -r
(
  cd "$LOCAL"
  source "$KIT/_common.sh"
  RESOLVED="$(buscar_commit_da_release striva-v1.0.0)"
  test "$RESOLVED" = "$OWN_COMMIT"
) && echo '  ✓ release fetch resolves the Striva remote, not the colliding local tag' || { echo '  ✗ contaminated tag won release resolution'; FAILS=$((FAILS+1)); }
check "release commit uses a private ref instead of rewriting local tags" git -C "$LOCAL" show-ref --verify --quiet refs/distribution/releases/striva-v1.0.0
check "contaminated public tag remains untouched" test "$(git -C "$LOCAL" rev-parse striva-v1.0.0)" = "$CONTAMINATED_TAG_COMMIT"

# The one-time branding bridge changes only the former product default.
BRAND_ENV="$WORK/brand.env"
cat > "$BRAND_ENV" <<'ENV'
APP_NAME="DeskcommCRM"
APP_ACCENT_HEX="#123456"
ENV
unset APP_NAME || true
load_env "$BRAND_ENV"
migrar_nome_padrao_da_marca "$BRAND_ENV" >/dev/null
load_env "$BRAND_ENV"
check "legacy product default is migrated to Striva Sales" test "$APP_NAME" = "Striva Sales"
check "the existing installation accent is preserved" grep -q '^APP_ACCENT_HEX="#123456"$' "$BRAND_ENV"
check "the migrated .env remains shell-sourceable" bash -c 'source "$1"; test "$APP_NAME" = "Striva Sales"' _ "$BRAND_ENV"
APP_NAME="Marca personalizada"
export APP_NAME
if [ -n "$(migrar_nome_padrao_da_marca "$BRAND_ENV")" ]; then
  echo '  ✗ a custom installation name was overwritten'
  FAILS=$((FAILS+1))
else
  echo '  ✓ a custom installation name is preserved'
fi

# A release that has not passed the three-image preflight must stop before the
# backup, checkout, schema apply or Compose recreation.
PROJ="$WORK/striva-install"
mkdir -p "$PROJ/hostgator-setup-kit" "$PROJ/supabase"
cp "$KIT/distribution.env" "$KIT/_common.sh" "$KIT/update.sh" "$KIT/agent.sh" "$PROJ/hostgator-setup-kit/"
printf 'services:\n  app:\n    image: ${APP_IMAGE:-x}\n' > "$PROJ/docker-compose.prod.yml"
printf 'select 1;\n' > "$PROJ/supabase/baseline.sql"
cat > "$PROJ/.env" <<'ENV'
APP_IMAGE=sha256:local-rollback-id
APP_PULL_POLICY=missing
SUPABASE_DB_URL=postgresql://example.invalid/test
INTERNAL_SECRET=test-secret
NEXT_PUBLIC_APP_URL=https://example.invalid
ENV
cat > "$PROJ/hostgator-setup-kit/backup.sh" <<BACKUP
#!/usr/bin/env bash
touch "$WORK/backup-ran"
BACKUP
chmod +x "$PROJ/hostgator-setup-kit/backup.sh"
git -C "$PROJ" init --quiet
git -C "$PROJ" config user.email test@example.invalid
git -C "$PROJ" config user.name test
: > "$PROJ/initial.txt"
git -C "$PROJ" add -A
git -C "$PROJ" commit --quiet -m initial
git -C "$PROJ" tag v99.0.0
: > "$DOCKER_LOG"
set +e
(cd "$PROJ" && bash hostgator-setup-kit/update.sh) > "$WORK/update.out" 2>&1
UPDATE_RC=$?
set -e
check "update refuses a release missing one of the images" test "$UPDATE_RC" -eq 3
check "failed preflight leaves local rollback image reference untouched" grep -q '^APP_IMAGE=sha256:local-rollback-id$' "$PROJ/.env"
check "failed preflight stops before backup" test ! -e "$WORK/backup-ran"
if grep -q 'compose .* up -d' "$DOCKER_LOG"; then echo '  ✗ Compose was recreated before image validation'; FAILS=$((FAILS+1)); else echo '  ✓ no Compose recreation occurred'; fi
check "checkout is unchanged after image failure" test "$(git -C "$PROJ" symbolic-ref --short HEAD)" = main -o "$(git -C "$PROJ" symbolic-ref --short HEAD)" = master

echo
if [ "$FAILS" -eq 0 ]; then echo 'OK — release isolation and update preflight passed.'; else echo "FAILED — $FAILS assertion(s)."; fi
exit "$FAILS"
