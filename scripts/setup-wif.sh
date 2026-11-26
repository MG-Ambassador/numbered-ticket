#!/usr/bin/env bash
# GitHub Actions から oc-ticket-2027 にデプロイするための設定（Workload Identity Federation。鍵ファイルは作らない）。
# 1回だけ、プロジェクトのオーナー権限のある Google アカウントで実行する（gcloud auth login 済みで）。
#
#   bash scripts/setup-wif.sh
#
# 何度実行しても同じ結果になるように、作成済みのものは飛ばす。
# 最後に表示される2つの値を GitHub のリポジトリ変数（Settings → Secrets and variables → Actions → Variables）に登録する。
set -euo pipefail

PROJECT_ID=oc-ticket-2027
REPO=MG-Ambassador/numbered-ticket
POOL=github
PROVIDER=github
SA_NAME=github-deploy
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
# 2nd gen の関数が動くときのサービスアカウント（既定の Compute Engine のもの）
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# cloudbilling: firebase deploy が課金状況を確かめるのに使う（デプロイ用のアカウントでは有効にできない。2026-11-27 に判明）
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com cloudbilling.googleapis.com --project "$PROJECT_ID"

if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT_ID" --display-name "GitHub Actions deploy"
fi

# firebase deploy（hosting・firestore・storage・functions）に要るロール
for role in \
  roles/firebase.admin \
  roles/cloudfunctions.admin \
  roles/run.admin \
  roles/artifactregistry.admin \
  roles/cloudscheduler.admin \
  roles/secretmanager.viewer \
  roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$role" --condition None >/dev/null
done
# 関数を実行用のサービスアカウントで動かすため
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --project "$PROJECT_ID" \
  --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser >/dev/null
# firebase deploy（functions）は App Engine の既定のサービスアカウントにも actAs を求める（2026-11-27 の初回の自動デプロイで判明）
gcloud iam service-accounts add-iam-policy-binding "${PROJECT_ID}@appspot.gserviceaccount.com" --project "$PROJECT_ID" \
  --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser >/dev/null
# 秘密の値は実行用のサービスアカウントに先に読ませておく（デプロイ用には Secret Manager の管理権限を渡さない）
gcloud secrets add-iam-policy-binding RATE_LIMIT_SECRET --project "$PROJECT_ID" \
  --member "serviceAccount:$RUNTIME_SA" --role roles/secretmanager.secretAccessor >/dev/null

if ! gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT_ID" --location global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT_ID" --location global --display-name "GitHub Actions"
fi
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT_ID" --location global --workload-identity-pool "$POOL" >/dev/null 2>&1; then
  # このリポジトリの main ブランチ以外（ほかのリポジトリ・PR・作業ブランチ）からのトークンは受け付けない
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project "$PROJECT_ID" --location global \
    --workload-identity-pool "$POOL" --display-name "GitHub" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '${REPO}' && assertion.ref == 'refs/heads/main'"
fi
# このリポジトリ（上の条件で main のみ）から、デプロイ用のサービスアカウントになれる
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" >/dev/null

echo
echo "GitHub のリポジトリ変数に登録する値:"
echo "  GCP_WIF_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
echo "  GCP_DEPLOY_SA    = ${SA}"
