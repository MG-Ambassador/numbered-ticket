# P2 関数

完了条件（設計書 6章）: 同時発券・同時呼出・二重発券・スキップ期限のテストが通る

| 順 | 範囲 | 状態 |
| --- | --- | --- |
| 1 | 来場者（V-01 入場、V-03 発券、V-05 いま向かいます、V-06 キャンセル）、board 計算、試行制限、新規登録を匿名に限るブロッキング関数 | **済**（2026-11-23）。同時発券・二重発券のテストが通過 |
| 2 | スタッフ（S-01〜S-09）。同時呼出のテスト | 未着手 |
| 3 | 管理者（A-01〜A-07）、管理スクリプト（管理者作成を含む） | 未着手 |
| 4 | 定期処理（3.4）。スキップ期限のテスト | 未着手 |

| 成果物 | ファイル |
| --- | --- |
| 関数の入口（callable・ブロッキング関数） | `functions/src/index.ts` |
| 関数の本体 | `functions/src/core/*.ts`（`visitor.ts`, `board.ts`, `rateLimit.ts` など） |
| 入出力とエラー理由 | `shared/src/api.ts` |
| テスト（本体を Emulator に対して直接呼ぶ） | `verify/src/p2/visitor.test.ts`（`npm run test:functions`） |
| E2E（Functions Emulator 経由） | `verify/src/e2e/visitor-flow.test.ts`（`npm run test:e2e`） |

## 決めたこと

### 1. 関数の本体は callable から切り離す

`core/` の関数は `(deps, caller, req)` を受け取る普通の非同期関数にした。`index.ts` は認証情報（`Caller`）と秘密の値を渡すだけ。テストは本体を Admin SDK で Emulator に直接呼ぶので、同時実行のテストを何十件も速く回せる。callable の配線は E2E で確かめる。

### 2. エラーは `details.reason` で返す

`HttpsError` の `details` に `{ reason, retryAfterSeconds? }` を入れる。理由と文言は `shared/src/api.ts` の `ERROR_REASONS`。画面（P3）は `reason` で出し分ける（停止中・満員・準備中など、V-03「理由を表示」）。

### 3. 入場コードの照合先

QR とコードにはイベント ID を入れないので、開場前・開場中（`scheduled` / `open`）のイベントのうち開場時刻が最も早いものを照合先にする。開場前でも入場（クレームの付与）はできるが、一覧はルールで開場まで読めない。

### 4. 試行制限は失敗だけを数える

V-01 の「端末ごと 5回/10分、IP ごと 50回/10分」は**失敗した試行**の回数とした。会場の Wi-Fi では大勢が同じ IP になるため、成功も数えると 50組で止まる。

- 端末 = 匿名ユーザーの uid。IP = `X-Forwarded-For` の末尾（7.4-3）。取れなければ `unknown`
- 保存先は `events/{eid}/rateLimits/{scope}_v1_<HMAC>`。uid・IP は `RATE_LIMIT_SECRET` の HMAC-SHA256 にしてから使い、TTL（`expireAt`）で消す
- 値は `shared` の `RATE_LIMITS`。スタッフコード（S-01、3回/10分）も同じ仕組みを使う

### 5. board は列を書くトランザクションの中で、その枠の分だけ書き直す

`writeBoardSlot` が `board/public` の `slots.<slotId>` と全体の `paused` を `set(..., { merge: true })` で書く。board 自体は**読まない**。読むと、どの枠の発券も board で競合するため。

- 状態の優先順: 全体停止 → 準備中（稼働ブース 0）→ 担当の停止 → 上限到達 → すぐ案内可（待ち 0 かつ空きブースあり）→ 受付中
- 稼働ブースの数を持つため、`QueueDoc` に `booths`（学生は占有者1件、教員はブースを設定した教員スタッフ）を足した。スタッフの関数（P2-2）が更新する
- 準備中の枠には発券しない（`preparing`）

### 6. 新規登録を匿名に限る

`beforeCreate`（`beforeUserCreated`）で、プロバイダ・メール・電話番号のどれかを持つ新規登録を拒否する。

- Emulator では匿名ログインでこの関数は呼ばれず、メール/パスワードの新規登録だけが呼ばれて拒否された（E2E で確認）。本番で匿名ログインが通ることは P4 で確かめる
- 残る穴: 匿名ユーザーがあとからメール/パスワードを**リンク**する操作は `beforeUserCreated` の対象外。リンクしてもクレームは付かないのでデータは読めないが、気になるなら `beforeUserSignedIn` で塞ぐ（全員のログインに関数の起動が挟まるので、今は入れていない）

### 7. 秘密の値

`RATE_LIMIT_SECRET` は `defineSecret` で宣言し、使う関数（今は `enterEvent`）だけに渡す。本番で空なら処理しない（Fail-Fast）。Emulator では既定の値を使う。

本番には 2026-11-23 に登録済み（版 1、複製先は asia-northeast1 のみ）。`firebase functions:secrets:set` が自分で作ると複製が `automatic`（マルチリージョン）になり「すべて東京」に反するため、秘密は gcloud で作ってから値だけ CLI で入れた。作り直すときも同じ手順にする（gcloud の既定アカウントは別なので `--account` で運用アカウントを指定する）。

```bash
gcloud secrets create RATE_LIMIT_SECRET --replication-policy=user-managed --locations=asia-northeast1 --labels=firebase-managed=functions --project oc-ticket-2027 --account <運用アカウント>
openssl rand -base64 32 | firebase functions:secrets:set RATE_LIMIT_SECRET --project prod --data-file=-
```

## まだ決めていない・あとでやること

- `issueTicket`・`callNext` の `minInstances: 1`（開催日のみ）、App Check の強制は P4 で設定する
- 本番へのデプロイは P2 がすべて終わってから
