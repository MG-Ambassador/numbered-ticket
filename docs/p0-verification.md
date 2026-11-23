# 設計書 7.4 の検証結果

- Emulator 検証: `verify/src/p0-rules.test.ts`（`npm run test:rules`）— 2026-11-15。P1 で削除し、7.4-1・7.4-4 の確認は本番ルールのテスト `verify/src/p1-rules.test.ts` に移した
- 本番検証: プロジェクト `oc-ticket-2027` — 2026-11-23。検証用の関数・ドキュメント・ユーザーは削除済み（TTL 計測用の `verifyTtl` のみ残置）

## 結果一覧

| # | 項目 | 結果 | 設計への影響 |
| --- | --- | --- | --- |
| 1 | ルールで `sign_in_second_factor == 'totp'` を判定できるか | **できる**。Emulator のルールテストで判定を確認。本番で実際に TOTP ログインしたトークンに `firebase.sign_in_second_factor: "totp"` が入ることを確認 | なし（設計どおり） |
| 2 | TOTP 登録に `emailVerified: true` が必要か | **必要**。未確認だと `UNVERIFIED_EMAIL`。Admin で `emailVerified: true` にすれば登録・ログインまで通る（メール送信は不要） | 管理者作成スクリプトで `emailVerified: true` を付けて作成する |
| 3 | callable 関数で実 IP が取れるか | **取れる。ただし `req.ip` は偽装できる**。クライアントが `X-Forwarded-For: 1.2.3.4` を送ると `req.ip` が `1.2.3.4` になる。Google が付け足す**末尾**の値（例: `1.2.3.4,202.13.156.120` の `202.13.156.120`）が実 IP | IP ごとの試行制限（V-01）は `X-Forwarded-For` の**末尾**を使う。`req.ip` は使わない |
| 4 | 購読中に閉場したときルールが再評価されるか | **本番では再評価される**。`events` を closed にしてから 15 秒以内に購読が `permission-denied` で止まった。Emulator では購読対象が次に更新されるまで止まらず、挙動が違う | なし。閉場処理で整理券も更新するので、どちらでも止まる |
| 5 | Firestore TTL の削除が24時間以内か | **計測中**。2026-11-23 02:41 UTC に期限切れの `verifyTtl/doc1〜3` を作成 | 2026-11-24 02:41 UTC 以降に残っているか確認する |
| 6 | 新規登録の無効化・パスワードポリシーを設定できるか | パスワードポリシーは**できる**（12〜128文字、強制。11文字以下は `PASSWORD_DOES_NOT_MEET_REQUIREMENTS`）。新規登録の無効化（`disabledUserSignup`）は**使えない**: 有効にすると**匿名ログインも `ADMIN_ONLY_OPERATION` で拒否される**。既存ユーザーのログインは可 | 新規登録は有効のままにする。メール/パスワードでの新規登録は `beforeUserCreated` ブロッキング関数で拒否し、匿名だけ通す。管理者は Admin SDK で作成（ブロッキング関数の対象外） |
| 7 | 料金の単価と無料枠 | 無料枠は確認（下表）。東京リージョンの単価は Google Cloud の料金ページが読み取れず**未確認** | 単価は P4 で実際の請求レポートから確認する |

## 料金の無料枠（https://firebase.google.com/pricing 、2026-11-23 時点）

| サービス | 無料枠 | 見込み |
| --- | --- | --- |
| Firestore 読み取り | 5万/日 | 開催日は一覧の購読で超える可能性あり。超過分は少額（P4 で計測） |
| Firestore 書き込み / 削除 | 2万/日 / 2万/日 | 収まる見込み |
| Firestore 保存 | 1 GiB | 収まる |
| Functions 呼出 | 200万/月（超過 $0.40/100万） | 収まる。minInstances 1 の待機費用は P4 で計測 |
| Authentication（Identity Platform） | 5万 MAU | 収まる（1日約150組） |
| Storage（*.firebasestorage.app） | **無料枠は us-central1・us-west1・us-east1 のみ**。東京のバケットは無料枠なし | プロフィール画像のみで数 MB のため、月に数円の見込み |

## 本番の現在の設定（2026-11-23）

- Authentication: 匿名とメール/パスワードを有効化。新規登録は有効のまま。TOTP の MFA を有効化（前後1区間まで許容）。パスワードポリシーは12文字以上を強制
- Firestore・Storage ルール: P1 のルールをデプロイ済み（2026-11-23。検証用パスは削除。索引・TTL はまだデプロイしていない）
- Functions: なし（`verifyIp` は削除済み）。コンテナイメージの削除ポリシー（1日）を設定済み

## 補足

- 7.4-4 のログ: Emulator `["snapshot n=0", "--- closed", "--- 購読対象を更新", "error permission-denied"]` ／ 本番 `["snapshot n=0", "--- closed", "error permission-denied", "--- 購読対象を更新"]`
- 本番検証のスクリプト: `verify/src/prod-reeval.mjs`（7.4-4）。TOTP 検証はスクラッチ上のスクリプトで実施
