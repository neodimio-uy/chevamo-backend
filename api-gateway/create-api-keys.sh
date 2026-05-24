#!/usr/bin/env bash
# Crea 5 API keys CheVamo en GCP. Cada key se restringe a invocar SOLO
# el servicio gestionado del API Gateway (no otras APIs de GCP del
# proyecto). Las restrictions de HTTP referrer / bundle ID se aplican
# manualmente en GCP Console después porque requieren info del cliente
# (bundle ID iOS, SHA-1 Android) que se setea cuando arranquen los
# clients.
#
# Re-ejecutable: si las keys ya existen, gcloud falla con error
# explícito — borrar la key previa o cambiar display name si se quiere.

set -euo pipefail

PROJECT="vamo-dbad6"

# Service name del API gestionado por Cloud API Gateway.
# Formato: <api-id>-<hash>.apigateway.<project>.cloud.goog
# Lo obtenemos del API resource creado previamente.
SERVICE_NAME=$(gcloud api-gateway apis describe chevamo-api --project="$PROJECT" --format='value(managedService)')
echo "Service del API Gateway: $SERVICE_NAME"

create_key() {
  local DISPLAY=$1
  echo ""
  echo "─── Creando key: $DISPLAY ───"
  gcloud services api-keys create \
    --project="$PROJECT" \
    --display-name="$DISPLAY" \
    --api-target=service="$SERVICE_NAME"
}

create_key "chevamo-ios-prod"
create_key "chevamo-android-prod"
create_key "chevamo-web-dashboard"
create_key "chevamo-web-data"
create_key "chevamo-web-public"

echo ""
echo "─── Keys creadas ───"
echo ""
echo "Listá las keys con sus secretos via:"
echo "  gcloud services api-keys list --project=$PROJECT --format='table(displayName,name,uid)'"
echo ""
echo "Get key string (sensible — NO loggear ni commitear):"
echo "  gcloud services api-keys get-key-string <uid> --project=$PROJECT"
echo ""
echo "Acción USER (GCP Console > APIs & Services > Credentials > <key>):"
echo "  1. chevamo-ios-prod      → restrict to iOS bundle id: uy.com.vamo.Vamo"
echo "  2. chevamo-android-prod  → restrict to package + SHA-1 fingerprint del APK"
echo "  3. chevamo-web-dashboard → HTTP referrer: https://dashboard.chevamo.com.uy/*, http://localhost:*/*"
echo "  4. chevamo-web-data      → HTTP referrer: https://data.chevamo.com.uy/*, http://localhost:*/*"
echo "  5. chevamo-web-public    → HTTP referrer: https://chevamo.com.uy/*, http://localhost:*/*"
