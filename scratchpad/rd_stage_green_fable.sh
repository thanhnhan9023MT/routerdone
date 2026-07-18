#!/usr/bin/env bash
set -euo pipefail
APP_DIR="/home/routerdone/routerdone"; DEPLOY_DIR="/home/routerdone/routerdone-deploy"
NODE_BIN_DIR="/opt/node-v20.20.2-linux-x64/bin"
target_slot="green"; target_port=20130   # active=blue → build inactive green
release="$(date -u +%Y%m%dT%H%M%SZ)-${target_slot}"; release_dir="${DEPLOY_DIR}/releases/${release}"
echo "[stage] build → ${target_slot}:${target_port} (2-core cap)"
cd "${APP_DIR}"; PATH="${NODE_BIN_DIR}:$PATH" taskset -c 0-1 nice -n 15 npm run build
echo "[stage] rsync → ${release_dir}"; mkdir -p "${release_dir}"
rsync -a --delete "${APP_DIR}/.next/standalone/" "${release_dir}/"
mkdir -p "${release_dir}/.next/static"; rsync -a --delete "${APP_DIR}/.next/static/" "${release_dir}/.next/static/"
[[ -d "${APP_DIR}/public" ]] && rsync -a --delete "${APP_DIR}/public/" "${release_dir}/public/"
cat > "${release_dir}/slot.env" <<STATE
PORT=${target_port}
ROUTERDONE_SLOT=${target_slot}
ROUTERDONE_RELEASE=${release}
STATE
"${NODE_BIN_DIR}/node" -e 'const D=require("/home/routerdone/routerdone/node_modules/better-sqlite3");const db=new D("/home/routerdone/.routerdone/db/data.sqlite",{readonly:true});try{for(const r of db.prepare("SELECT key,value FROM runtime_config ORDER BY key").all())process.stdout.write(r.key+"="+r.value+"\n")}catch(e){}db.close();' >> "${release_dir}/slot.env" 2>/dev/null || true
ln -sfn "${release_dir}" "${DEPLOY_DIR}/slots/${target_slot}"
echo "[stage] restart routerdone-app@${target_slot}"; sudo -n systemctl restart "routerdone-app@${target_slot}.service"
ok=0; for i in $(seq 1 30); do "${DEPLOY_DIR}/scripts/healthcheck.sh" "${target_port}" && { ok=1; break; }; sleep 1; done
[[ "$ok" == "1" ]] && echo "[stage] DONE green healthy ${target_port}, NOT switched" || { echo "[stage] HEALTHCHECK FAILED"; exit 1; }
echo "RELEASE=${release}"
