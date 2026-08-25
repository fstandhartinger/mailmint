#!/usr/bin/env bash
# Everything MailMint created, and how to remove it.
# Infrastructure nobody wrote down is infrastructure that bills forever.
set -uo pipefail

HETZNER_SSH_KEY_NAME="mailmint-ops"
NEON_PROJECT_ID="crimson-king-93827945"
RENDER_HOOKBIN="mailmint-hookbin"
GH_REPOS=("fstandhartinger/mailmint" "fstandhartinger/n8n-nodes-mailmint")

need() { [ -n "${!1:-}" ] || { echo "  ! \$$1 not set — skipping that provider"; return 1; }; }

list() {
  echo "== MailMint infrastructure =="
  echo
  if need RENDER_API_KEY; then
    echo "-- Render"
    curl -s -H "Authorization: Bearer $RENDER_API_KEY" -H accept:application/json \
      "https://api.render.com/v1/services?limit=50" \
    | node -pe 'JSON.parse(require("fs").readFileSync(0)).map(s=>s.service).filter(s=>/mailmint/.test(s.name)).map(s=>`   ${s.name} (${s.id}) plan=${(s.serviceDetails||{}).plan||"-"} suspended=${s.suspended} ${(s.serviceDetails||{}).url||""}`).join("\n")||"   none"' 2>/dev/null
  fi
  if need NEON_API_KEY; then
    echo "-- Neon"
    curl -s -H "Authorization: Bearer $NEON_API_KEY" \
      "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID" \
    | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.project?`   ${j.project.name} (${j.project.id}) — free tier`:"   not found"' 2>/dev/null
  fi
  if need HETZNER_API_TOKEN; then
    echo "-- Hetzner"
    curl -s -H "Authorization: Bearer $HETZNER_API_TOKEN" https://api.hetzner.cloud/v1/servers \
    | node -pe 'const s=JSON.parse(require("fs").readFileSync(0)).servers||[];s.length?s.map(x=>`   SERVER ${x.name} ${x.public_net.ipv4.ip}`).join("\n"):"   no servers (creation is blocked on this account)"' 2>/dev/null
    curl -s -H "Authorization: Bearer $HETZNER_API_TOKEN" https://api.hetzner.cloud/v1/ssh_keys \
    | node -pe 'const k=JSON.parse(require("fs").readFileSync(0)).ssh_keys.filter(k=>k.name==="'"$HETZNER_SSH_KEY_NAME"'");k.length?`   ssh key ${k[0].name} (${k[0].id})`:"   no ssh key"' 2>/dev/null
  fi
  echo "-- GitHub repos (public, free): ${GH_REPOS[*]}"
  echo "-- npm package n8n-nodes-mailmint: see note in INFRASTRUCTURE.md"
  echo
  echo "Monthly cost: see ops/INFRASTRUCTURE.md"
}

destroy() {
  echo "This will DELETE:"
  echo "  - the Render service '$RENDER_HOOKBIN' and any other Render service named *mailmint*"
  echo "  - the Neon project $NEON_PROJECT_ID AND ALL ITS DATA"
  echo "  - the Hetzner SSH key '$HETZNER_SSH_KEY_NAME'"
  echo "It will NOT delete the GitHub repos or unpublish anything from npm."
  read -rp "Type DESTROY to continue: " a; [ "$a" = "DESTROY" ] || { echo "aborted"; return 1; }

  if need RENDER_API_KEY; then
    for id in $(curl -s -H "Authorization: Bearer $RENDER_API_KEY" -H accept:application/json \
        "https://api.render.com/v1/services?limit=50" \
        | node -pe 'JSON.parse(require("fs").readFileSync(0)).map(s=>s.service).filter(s=>/mailmint/.test(s.name)).map(s=>s.id).join("\n")' 2>/dev/null); do
      echo -n "  render $id -> "
      curl -s -X DELETE -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$id" -o /dev/null -w "%{http_code}\n"
    done
  fi
  if need NEON_API_KEY; then
    echo -n "  neon $NEON_PROJECT_ID -> "
    curl -s -X DELETE -H "Authorization: Bearer $NEON_API_KEY" \
      "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID" -o /dev/null -w "%{http_code}\n"
  fi
  if need HETZNER_API_TOKEN; then
    kid=$(curl -s -H "Authorization: Bearer $HETZNER_API_TOKEN" https://api.hetzner.cloud/v1/ssh_keys \
      | node -pe 'const k=JSON.parse(require("fs").readFileSync(0)).ssh_keys.filter(k=>k.name==="'"$HETZNER_SSH_KEY_NAME"'");k.length?k[0].id:""' 2>/dev/null)
    [ -n "$kid" ] && { echo -n "  hetzner ssh key $kid -> "; curl -s -X DELETE -H "Authorization: Bearer $HETZNER_API_TOKEN" "https://api.hetzner.cloud/v1/ssh_keys/$kid" -o /dev/null -w "%{http_code}\n"; }
  fi
  echo "done. Local key ~/.ssh/mailmint_ed25519 is untouched; remove it by hand if you want it gone."
}

suspend() {
  need RENDER_API_KEY || return 1
  for id in $(curl -s -H "Authorization: Bearer $RENDER_API_KEY" -H accept:application/json \
      "https://api.render.com/v1/services?limit=50" \
      | node -pe 'JSON.parse(require("fs").readFileSync(0)).map(s=>s.service).filter(s=>/mailmint/.test(s.name)).map(s=>s.id).join("\n")' 2>/dev/null); do
    echo -n "  suspend $id -> "
    curl -s -X POST -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$id/suspend" -o /dev/null -w "%{http_code}\n"
  done
}

case "${1:-}" in
  --list) list ;;
  --suspend) suspend ;;
  --destroy) destroy ;;
  *) echo "usage: $0 --list | --suspend | --destroy"; exit 1 ;;
esac
