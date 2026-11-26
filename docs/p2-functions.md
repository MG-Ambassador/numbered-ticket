# P2 関数

完了条件（設計書 6章）: 同時発券・同時呼出・二重発券・スキップ期限のテストが通る → **すべて通過**（2026-11-24。`npm run test:functions` 90件、`npm run test:e2e` 4件）

| 順 | 範囲 | 状態 |
| --- | --- | --- |
| 1 | 来場者（V-01 入場、V-03 発券、V-05 いま向かいます、V-06 キャンセル）、board 計算、試行制限、新規登録を匿名に限るブロッキング関数 | **済**（2026-11-23）。同時発券・二重発券のテストが通過 |
| 2 | スタッフ（S-01〜S-09）。同時呼出のテスト | **済**（2026-11-23）。同時呼出のテストが通過 |
| 3 | 管理者（A-01〜A-07）、管理スクリプト（管理者作成を含む） | **済**（2026-11-24） |
| 4 | 定期処理（3.4）。スキップ期限のテスト | **済**（2026-11-24）。スキップ期限のテストが通過 |

| 成果物 | ファイル |
| --- | --- |
| 関数の入口（callable・ブロッキング関数） | `functions/src/index.ts` |
| 関数の本体 | `functions/src/core/*.ts`（`visitor.ts`, `staff.ts`, `admin.ts`, `lifecycle.ts`, `board.ts`, `rateLimit.ts` など） |
| 管理者の作成・無効化 | `scripts/create-admin.mjs` |
| 入出力とエラー理由 | `shared/src/api.ts` |
| テスト（本体を Emulator に対して直接呼ぶ） | `verify/src/p2/visitor.test.ts`, `staff.test.ts`, `admin.test.ts`, `scheduler.test.ts`（`npm run test:functions`） |
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

### 8. スタッフの担当と列の操作

| 関数 | 内容 |
| --- | --- |
| `staffLogin`（S-01） | 8桁コードだけ。役割と担当はコードで決まる（学生枠ごとのコード → その枠、教員のコード → 教員相談）。学生は枠が空いていればそのまま占有し、別の端末が担当中なら担当なしでログインだけする。端末ごと 3回/10分（失敗のみ）。担当を持ったまま別の担当のコードでは入り直せない（`alreadyAssigned`）。同じコードの再ログインでは担当を返す |
| `claimSlot`（S-02 学生） | ログインに使ったコードの枠（`staff.allowedSlotId`）だけを占有できる（ほかの枠は `forbidden`）。`slots.occupant` と `queues.booths` を同時に書く。同時に取り合うと1台だけ成功（`slotTaken`） |
| `setBooth`（S-02 教員） | ブース番号（英数字とハイフン、16文字まで）。ほかの教員と同じ番号は不可（`boothTaken`） |
| `releaseAssignment`（S-09） | 対応中がなければ担当を外す。列は残り、学生枠は「準備中」になる |
| `heartbeat` | `staff.lastSeenAt` の更新（生存確認） |
| `callNext`（S-04） | 列の先頭を呼ぶ。**1人のスタッフが同時に対応できるのは1組**（`busy`）。開場中のみ。受付停止中も呼べる |
| `startConsult` / `completeConsult`（S-04） | 呼んだ本人だけが操作できる。完了で `memo` を消し、相談時間（開始→完了）を `recentDurations` の先頭に入れる |
| `skipTicket` / `returnTicket`（S-05） | スキップは `skipReturnMinutes` 後が期限。期限ちょうどまでは復帰でき、列の先頭へ戻る（上限超過可）。復帰はその列の担当なら誰でも押せる |
| `setSlotPaused`（S-07） | 自分の列の受付停止・再開。教員はブース未設定でも可 |
| `setQueueLimit`（S-08） | 学生 1〜10（1刻み）、教員 10〜80（5刻み）。`auditLog` に `queueLimit.change`（from/to）を残す。下げても並んでいる方はそのまま |

- 学生の担当は `staff.slotId` と `slots.occupant.uid` の**両方**が自分のときだけ有効にした。管理者の強制解除（A-05）は `occupant` を消すだけで、その学生の操作が `notAssigned` で止まる
- スキップしても整理券の `booth` は残す。来場者が復帰のために向かう先を出すため（V-07）
- 5秒の取り消し（S-06）は画面側で送信を遅らせるだけなので、関数はない
- テストの準備（`verify/src/p2/fixture.ts`）は board も最初から作る。本番では管理者の準備（P2-3）で作る

### 9. 管理者の操作は1つの callable にまとめる

`adminApi` が `{ op, ... }`（shared の `AdminRequest`）を受けて振り分ける。管理者は2名で呼出は少ないので、関数を分けずに起動待ちを1台にまとめた。呼べるのは admin クレーム＋TOTP 済みのトークンだけ（ルールの `isAdmin` と同じ条件）。日時は ISO 8601 の文字列でやり取りする。

| op | 内容 |
| --- | --- |
| `recordLogin` / `completeSetup`（A-01） | ログインを auditLog に記録。初回設定（パスワード変更・TOTP 登録）のあとで `initial` クレームを外す |
| `createEvent` / `updateEvent`（A-02） | 作成時にコード2つ・教員相談の枠と列・board を一緒に作る。閉場後は変更不可。開催は24時間以内、閉場は今より後（年の入力違いで意図せず開場するのを防ぐ）。開場中に開場時刻を未来へ変えると、入場・整理券がなければ開場前に戻す（あれば `eventStarted`） |
| `viewCodes` / `reissueCode`（A-03） | どちらも auditLog に残す。再発行しても、入場済み・ログイン済みの端末はそのまま使える |
| `importSlots` / `upsertSlot` / `updateFacultyProfile` / `deleteSlot` / `uploadAvatar`（A-04） | 下の「枠の登録」 |
| `openEvent` / `closeEvent` / `setGlobalPaused` / `updateSlotSettings` / `forceRelease`（A-05） | 下の「当日の操作」 |
| `dashboard` / `previewStats`（A-06・A-07） | 直近10分の発券数とコードの失敗数、警告。統計は当日の整理券から計算するだけ（保存は定期処理） |

**コード（A-03）**: `crypto.randomInt` で作り、推測されやすいもの（数字が3種類以下、同じ数字が4連続、1ずつ増減する並び、4桁以下の繰り返し、8桁の日付）は作り直す。スタッフコードは教員共通の1つ（`facultyCode`）と学生枠ごとの1つずつ（`slotCodes`）。学生枠のコードは枠の登録で作り、枠の削除で消す。再発行は入場・教員・枠ごとにできる。どのコードも先頭4桁が重ならないようにする。ポスターの QR は `entryUrl(origin, code)`（`<公開URL>/#code=<入場コード>`）。

**枠の登録（A-04）**:

- CSV の見出しは `id,nickname,department,bio,tags,location,order`。`id` が空なら新しい枠、あれば既存の枠を直す（占有・画像・上限・停止はそのまま。位置を変えると占有中の学生の案内先も変わる）。タグは空白・読点・セミコロンで区切る。1回 50 行まで
- 1行でも誤りがあれば何も書かず、`details.rows` に行と列を返す
- URL・SNS の ID は全角を半角にしてから判定する（`https:`、`www.`、`xxx.com` などのドメイン、`@xxx`、「インスタ:」「LINE ID」など）
- 画像は 512KB まで。`Content-Type` だけでなく先頭のバイトで JPEG / PNG / WebP か確かめる。画面で縮小してから送る（P3）
- 削除は、並んでいる方・担当がいない枠だけ

**当日の操作（A-05）**:

- 閉場（`closeEvent`）: ①状態を closed にする（以降の発券・呼出は止まり、購読もルールで止まる）②有効な整理券を expired にして問診メモを消す ③列を空にする。②③はバッチで行い、途中で失敗しても再実行で続きから進む。定期処理（P2-4）もこれを使う
- 全体の一時停止: board を全枠作り直す。列ごとの停止の設定は残る
- 強制解除: 学生の占有・教員のブースを外す。対応中の整理券は列に残し `staffUid` を null にして、次にその列を担当したスタッフが引き継げるようにした（壊れた端末の対応中が宙に浮かないように）

**管理者の作成**（`scripts/create-admin.mjs`）: `emailVerified: true`、クレーム `{ admin: true, initial: true }`、20文字の仮パスワードを一度だけ表示する。本番は運用アカウントの Application Default Credentials で実行する。`--disable` で無効化（セッションも失効）。

```bash
node scripts/create-admin.mjs --project oc-ticket-2027 --email <メール>
```

画面（P3）は `initial` クレームがあればパスワード変更と TOTP 登録の画面に進め、済んだら `completeSetup` を呼ぶ。サーバ側ではパスワードを変えたかまでは確かめられない（TOTP の登録だけ確かめる）。

### 10. トランザクションの再試行

すべてのトランザクションを `runTx`（`core/common.ts`）で実行する。SDK の再試行（10回）を使い切った競合（`ABORTED`）も間を空けて4回まで試し直し、それでも通らなければ `contention`（「混み合っています」）で返す。

- Emulator では、同時実行のテストでロック待ちが長くなるとトランザクションが閉じられ、SDK が再試行しない `INVALID_ARGUMENT: Transaction is invalid or closed` で失敗していた（全体を流すと3回に1回ほど）。これも再試行の対象にした。コミットされていないので試し直して安全
- 20人同時の発券は Emulator で 8〜13 秒かかる（ロック待ち）。テストの制限時間は 60 秒にした。本番の速さは P4 で計測する
- 発券はどの枠でも `events/{eid}` の採番で競合する。1日150組なら問題ない見込みだが、P4 の負荷テストで p95 を確かめる

### 11. 定期処理（3.4）

`scheduledTick`（1分ごと、Asia/Tokyo、再試行なし）が `core/scheduler.ts` の `tick` を呼ぶ。`scheduled` / `open` / `closed` のイベントを順に見て、次を行う。何度呼んでも同じ結果になるように書き、1つのイベントで失敗してもほかのイベントは続ける。

| 時刻 | 処理 |
| --- | --- |
| 開場時刻〜閉場時刻 | `scheduled` → `open`（`openEvent`）。開場しないまま閉場時刻を過ぎたら、そのまま閉場する |
| 閉場時刻 | `closeEvent`（管理者の閉場と同じ）。auditLog の actor は `system` |
| 開場中は毎回 | スキップの復帰期限切れ（`expireSkipped`） |
| 閉場後は毎回 | 有効な整理券が残っていれば後片付けの続き（1件だけ読んで確かめる） |
| 閉場＋1時間 | 削除（`purgeEvent`） |

**スキップの復帰期限**: `tickets (state, returnDeadline)` の索引で `returnDeadline < 今` のスキップ中を探し、1件ずつトランザクションで expired にする（列の skipped・board・入場記録の有効な整理券からも外す）。復帰は `今 <= 期限`、無効化は `今 > 期限` なので、期限ちょうどは復帰できる側。期限の直後に復帰と定期処理が同時に走っても、どちらか一方だけが通ることをテストで確かめた。定期処理は1分ごとなので、期限から無効化まで最大1分ほど遅れる（その間の復帰は関数側で拒否する）。

**閉場＋1時間の削除**（設計書 4章 プライバシー）:

1. 統計を `stats/{開催日（JST）}` に保存する（すでにあれば上書きしない）
2. 入場記録・スタッフの記録にある uid のうち、匿名ユーザーだけを Auth から削除する（メール・電話・外部 IdP・admin クレームのあるユーザーは消さない）
3. Storage のプロフィール画像（`events/{eid}/avatars/`）を削除する
4. `stats` 以外のサブコレクション（tickets, queues, slots, board, visitors, staff, rateLimits, auditLog, secrets）を `recursiveDelete` で消す
5. 最後にイベントを `purged` にする。途中で失敗しても `closed` のままなので、次の回に最初から進み直す

## まだ決めていない・あとでやること

- `issueTicket`・`callNext` の `minInstances: 1`（開催日のみ）、App Check の強制は P4 で設定する
- 本番へのデプロイ: 関数・索引・TTL をまとめて行う。索引・TTL は 7.4-5 の TTL 計測（`verifyTtl`）が終わってから。初回のデプロイで Cloud Scheduler の API の有効化を求められる（ジョブは月3件まで無料。`scheduledTick` の1件だけ）→ 2026-11-24 に P3 時点のコードでデプロイし、2026-11-26 に main（PR #4・#5 を含む）に追いついた（[p4-integration.md](p4-integration.md)）
- E2E では Functions Emulator が `RATE_LIMIT_SECRET` を demo プロジェクトの Secret Manager に取りに行き、403 のログが出る。値は Emulator 用の既定値に切り替わるので、テストには影響しない
