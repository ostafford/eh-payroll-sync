#!/usr/bin/env bash
#
# Issue #141: do EH's employee filters return TERMINATED employees? The
# Pre-create check (ADR-0010) looks people up by email, TFN and name + DOB;
# a rehire is only caught if those filters can see a terminated record.
#
# Read-only unless --delete. Run it from the REHEARSAL clone (it reads that
# clone's .dev.vars), against a throwaway employee with fake details:
#
#   scripts/probe-eh-terminated-filters.sh --precheck   # before creating: is the test TFN/email unused?
#   scripts/probe-eh-terminated-filters.sh --id 12345   # after terminating them in the EH UI
#   scripts/probe-eh-terminated-filters.sh --id 12345 --delete
#
# Prints counts and ids only, never a TFN. Test values (fake, not a real person):
EMAIL="zztest.terminated@example.com"
FIRST="Zztest"
SURNAME="Terminated"
DOB="${PROBE_DOB:-1990-01-01}" # override if the record was saved with another date
TFN="256219870" # checksum-valid, checked unused by --precheck

set -uo pipefail
BASE="${EH_BASE_URL:-https://api.yourpayroll.com.au/api/v2}"
_dv() { [[ -f .dev.vars ]] && sed -n "s/^$1=//p" .dev.vars | tail -n1; }
API_KEY="${EH_API_KEY:-$(_dv EH_API_KEY || true)}"
BUSINESS_ID="${EH_BUSINESS_ID:-$(_dv EH_BUSINESS_ID || true)}"
[[ -n "$API_KEY" && -n "$BUSINESS_ID" ]] || { echo "set EH_API_KEY and EH_BUSINESS_ID (env or .dev.vars) first" >&2; exit 1; }
AUTH="Basic $(printf '%s:' "$API_KEY" | base64 | tr -d '\n')"
B="$BASE/business/$BUSINESS_ID"

ID="" PRECHECK="" DELETE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --id) ID="$2"; shift 2 ;;
    --precheck) PRECHECK=1; shift ;;
    --delete) DELETE=1; shift ;;
    *) echo "unknown arg $1" >&2; exit 1 ;;
  esac
done

# get PATH -> prints "<http status> <body>" on one line pair
get() { curl -sS -G -w '\n%{http_code}' -H "authorization: $AUTH" -H "accept: application/json" "$B$1" "${@:2}"; }

# filter LABEL ODATA -> "LABEL: HTTP 200, N found, ids [..], target included: yes/no"
filter() {
  local out code body
  out=$(get "/employee/unstructured" --data-urlencode "\$filter=$2")
  code=$(tail -n1 <<<"$out"); body=$(sed '$d' <<<"$out")
  python3 -c '
import json,sys
label,code,target,body=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
try: rows=json.loads(body)
except Exception: print(f"{label}: HTTP {code}, unreadable body"); sys.exit()
if not isinstance(rows,list): print(f"{label}: HTTP {code}, not a list: {str(rows)[:120]}"); sys.exit()
ids=[r.get("id") for r in rows]
inc="" if not target else ("  target included: " + ("YES" if int(target) in ids else "no"))
print(f"{label}: HTTP {code}, {len(rows)} found, ids {ids}{inc}")
' "$1" "$code" "$ID" "$body"
}

run_filters() {
  filter "email                " "emailAddress eq '$EMAIL'"
  filter "TFN                  " "taxFileNumber eq '$TFN'"
  # A dateOfBirth literal in a filter was never tested (research doc), so try
  # both OData forms; the name-only filter is the fallback (DOB compared locally).
  filter "name + DOB datetime''" "firstName eq '$FIRST' and surname eq '$SURNAME' and dateOfBirth eq datetime'${DOB}T00:00:00'"
  filter "name + DOB bare date " "firstName eq '$FIRST' and surname eq '$SURNAME' and dateOfBirth eq ${DOB}"
  filter "name only (fallback) " "firstName eq '$FIRST' and surname eq '$SURNAME'"
}

if [[ -n "$PRECHECK" ]]; then
  echo "Precheck: the test values should match nobody yet."
  run_filters
  exit 0
fi
[[ -n "$ID" ]] || { echo "pass --id <EH employee id> or --precheck" >&2; exit 1; }

echo "Target EH employee $ID:"
out=$(get "/employee/unstructured/$ID"); code=$(tail -n1 <<<"$out")
python3 -c '
import json,sys
code,body=sys.argv[1],sys.argv[2]
try: e=json.loads(body)
except Exception: print(f"  GET by id: HTTP {code}, unreadable"); sys.exit()
keep={k:e.get(k) for k in ("id","firstName","surname","emailAddress","dateOfBirth","startDate","endDate","status")}
keep["taxFileNumber set"]=bool(e.get("taxFileNumber"))
print(f"  GET by id: HTTP {code}  {keep}")
' "$code" "$(sed '$d' <<<"$out")"

echo
echo "Unstructured filters (what the Pre-create check would call):"
run_filters

echo
echo "Unfiltered list, all pages - is the terminated employee in it at all?"
skip=0 found=no total=0
while :; do
  out=$(get "/employee/unstructured" --data-urlencode "\$top=100" --data-urlencode "\$skip=$skip")
  n=$(sed '$d' <<<"$out" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(len(r))' 2>/dev/null || echo 0)
  sed '$d' <<<"$out" | python3 -c "import json,sys; sys.exit(0 if any(r.get('id')==$ID for r in json.load(sys.stdin)) else 1)" 2>/dev/null && found=yes
  total=$((total + n)); [[ "$n" -lt 100 ]] && break; skip=$((skip + 100)); sleep 0.3
done
echo "  $total employees listed; target included: $found"

if [[ -n "$DELETE" ]]; then
  echo
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "authorization: $AUTH" "$B/employee/$ID")
  echo "DELETE employee $ID: HTTP $code"
fi
