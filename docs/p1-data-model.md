# P1 データモデル・ルール

完了条件: 「他人の整理券を読めない」などのルールテストが全件通る（設計書 6章）→ **59件すべて通過**（2026-11-23、`npm run test:rules`）

| 成果物 | ファイル |
| --- | --- |
| 共有型・定数・パス | `shared/src/model.ts`, `shared/src/index.ts`, `shared/src/paths.ts` |
| Firestore ルール | `firestore.rules` |
| Storage ルール | `storage.rules` |
| 索引・TTL | `firestore.indexes.json` |
| ルールテスト | `verify/src/p1-rules.test.ts` |

## 決めたこと

### 1. 誰が何者かはカスタムクレームで判定する

関数（P2）が入場コード・スタッフコードを照合したあと、匿名ユーザーに `setCustomUserClaims` でクレームを付けます。クライアントはそのあと `getIdToken(true)` でトークンを更新します。

| 利用者 | クレーム | 付ける処理 |
| --- | --- | --- |
| 来場者 | `{ eid, role: 'visitor' }` | 入場コード照合（V-01） |
| 学生スタッフ | `{ eid, role: 'student' }` | 学生枠ごとのスタッフコード（S-01）。そのコードの枠だけを担当できる |
| 教員スタッフ | `{ eid, role: 'faculty' }` | 教員共通のスタッフコード（S-01） |
| 管理者（運営アカウント） | `{ admin: true, opId, opv }` | 運営ID＋パスワードのログイン（`operatorLogin` のカスタムトークン）。ルールは `operators/{opId}` が有効・仮パスワードでなく version が `opv` と同じ・ログインから8時間以内を確かめる |

**理由**: `visitors/{uid}` などをルールで `get()` して判定すると、一覧の購読のたびにルール内の読み取りが増える。数百端末が `board/public` を購読するため、読み取りの無料枠（5万/日）を圧迫しやすい。クレームなら追加の読み取りがない。

**例外**: 「開場中か」は `get(events/{eid})` で、「学生スタッフが枠を占有しているか」は `get(slots/{slotId})` で判定する。どちらも当日に変わる値で、クレームでは即時に反映できないため。開場中かの判定は 7.4-4 で、閉場すると購読が止まることを確認済み。

### 2. 読める範囲（設計書 5.1 の解釈）

| パス | 読める人 |
| --- | --- |
| `events/{eid}` | 自イベントのクレームを持つ全員、管理者。閉場後も読める（「閉場しました」を出すため） |
| `secrets/codes` | なし（管理者も不可。表示は関数経由で監査ログに残す） |
| `slots/*`, `board/public` | 開場中の来場者、開場前・開場中のスタッフ、管理者 |
| `queues/{slotId}` | 担当スタッフ（学生は占有者、`faculty` は教員スタッフ全員）、管理者 |
| `tickets/{id}` | 本人（開場中のみ）、担当スタッフ（開場前・開場中）、管理者 |
| `visitors/{uid}` | 本人、管理者 |
| `staff/{uid}` | 本人、管理者 |
| `auditLog/*`, `stats/*` | 管理者（運営アカウントのログイン） |
| `operators/*`, `operatorAudit/*`, `rateLimits/*`（イベントに属さない） | 誰も読み書きできない（ルールの `get()` と Admin SDK だけ） |
| Storage `events/{eid}/avatars/{slotId}` | `slots` と同じ |

- 設計書の `visitors` / `staff` の「本人、スタッフ」は「それぞれ本人」と読み、スタッフが来場者の入場記録を読む用途はないので許可していない。
- 担当スタッフかどうかは整理券の `slotId` だけで決まる（`faculty` なら教員、それ以外は占有者）。そのため、スタッフは `where('slotId', '==', X)` で自分の列の整理券を一覧できる。来場者は `where('visitorUid', '==', 自分)` でのみ一覧できる。
- 書き込みは全パスで拒否。App Check の強制はルールではなく各サービスの設定で行う（P4）。

### 3. 問診の持ち方

学年・テーマは統計に使うので閉場＋1時間まで残し、自由記述の `memo` だけを完了・キャンセル・閉場で `null` にする。`memo` は索引の対象から外した。

### 4. 索引と TTL

- `tickets (slotId, state, number)`: スタッフの待機リスト
- `tickets (state, returnDeadline)`: 定期処理でスキップ期限切れを探す
- TTL: `tickets` / `visitors` / `staff` / `auditLog` の `expireAt`。閉場＋1時間の削除は関数で行い、TTL は漏れた場合の保険（7.4-5 で24時間以内に削除されることを確認済み）

## P2 に引き継ぐこと

- クレームの付与と、付与後のトークン更新（クライアント側は P3）
- 整理券の状態遷移は `TICKET_TRANSITIONS` 以外を拒否する
- `memo` の削除（完了・キャンセル・閉場）
- 索引・TTL の本番へのデプロイ（`firebase deploy --only firestore:indexes --project prod`）。7.4-5 の TTL 計測（`verifyTtl`）が終わってから行う。`verifyTtl` の TTL 設定はファイルにないため、デプロイ時に削除を求められても削除しない → 2026-11-24 にデプロイ済み（[p4-integration.md](p4-integration.md)）

## 本番へのデプロイ（2026-11-23）

`firebase deploy --only firestore:rules,storage --project prod` で Firestore・Storage のルールをデプロイした。本番のルールが手元のファイルと一致することを Rules API で確認済み。P0 の検証用パス（`verify/mfa`, `verifyLive`）はなくなったため、`verify/src/prod-reeval.mjs` はもう動かない

Storage ルールの `firestore.get()` のため、`service-<番号>@firebase-rules.iam.gserviceaccount.com` に `roles/firebaserules.firestoreServiceAgent`（Firebase Rules Firestore Service Agent）を付与した（2026-11-23）。実際に画像が読めるかは、画像を置く P2・P3 で確かめる
