# P4 結合・負荷テスト、本番へのデプロイ

設計書 6章の P4: 150組分の自動シナリオ、読み書き件数の計測、本番環境へのデプロイ（GitHub Actions＋Workload Identity Federation）。
完了条件は「費用が見積りどおり、発券・呼出の p95 が 300ms 以内」。

## 進み具合

| # | 作業 | 状態 |
| --- | --- | --- |
| 1 | 150組の負荷シナリオ（`verify/src/p4/load.scenario.ts`） | **済**。Emulator で流れることを確認。本番は未実施 |
| 2 | App Check・常駐台数を設定で切り替えられるようにする | **済**（コード）。本番の設定は未実施 |
| 3 | GitHub Actions＋WIF のデプロイ（`.github/workflows/deploy.yml`、`scripts/setup-wif.sh`） | **済**。2026-11-26 に `setup-wif.sh` を実行し、リポジトリ変数と Environment `production` を登録。手動実行で画面のデプロイが2回通った |
| 4 | 画面のバンドル: スタッフ・管理画面を分割読み込みに | **済** |
| 5 | 本番へのデプロイ（関数・索引・TTL・画面） | **済**。2026-11-26 に main（`d6f171a`、PR #4・#5 を含む）に追いついた（下の「本番の現在の状態」） |
| 6 | 本番での負荷テスト・費用の計測 | **一部**。2026-11-26 04:40〜05:10 UTC に流した形跡あり（`issueTicket` への POST 約200件、イベントは片付け済み）。結果の JSON・p95 は記録が見つからず、費用の計測も未 |
| 7 | 本番でしか確かめられない項目（下の一覧） | 未。5 のあと |

## 1. 負荷シナリオ

```bash
npm run test:load          # Emulator（Firestore・Auth・Functions）で 150 組
```

イベント `load-<日時>` を Admin SDK で作り（`seed-emulator.mjs` と同じ形）、次を同時に流す。終わったらイベントと作った匿名ユーザーを消す。

- スタッフ: 学生7人（各枠を占有）＋教員4人（ブース）。自分の列を購読し、待ちがあれば 呼出 → 0.3秒後に開始 → 相談（`LOAD_CONSULT_MS` の 0.5〜1.5倍）→ 完了。3% は不在スキップ → 1秒後に復帰
- 来場者 150組: 匿名ログイン → 入場 → トークン更新 → 一覧（board）を購読 → 40% は学生枠、60% は教員相談で発券（上限なら教員相談へ回る）→ 自分の整理券を購読 → 呼ばれたら「いま向かいます」→ 完了まで待つ。待っている間にまれにキャンセル
- 最初の `LOAD_RUSH` 組は同時に来る（開場直後の混雑）。以降は `LOAD_ARRIVAL_MS` の間隔（0.5〜1.5倍）。既定の 0.6秒・相談 3秒は、相談 10分・開催5時間で150組を 1/200 に縮めたもの

結果は画面に表で出し、`verify/out/<eid>-<実行先>.json` に保存する（git には入れない）。

| 出すもの | 内容 |
| --- | --- |
| `latencyMs` | 関数ごとの応答時間（クライアントから見た往復。p50・p95・最大） |
| `outcomes` | 完了・キャンセル・発券できず（上限）・エラー・時間切れの組数 |
| `errors` | 関数ごと・理由ごとの失敗数（`queueEmpty` などの想定内のものも含む） |
| `listenerReads` | 購読で受け取ったスナップショット数（1件＝1読み取り）。関数側の読み取りは含まない |

本番では発券・呼出の p95 ≦ 300ms をテストの合否に含める。Emulator では速さを見ない。

### Emulator の結果（2026-11-25）

150組、学生枠7・教員ブース4、開場直後に20組同時・以降 0.6秒間隔、相談 1.5〜4.5秒、関数の呼び出しは1件ずつ（下の注意）。所要 約1分30秒。

| 結果 | 値 |
| --- | --- |
| 完了・キャンセル・発券できず・エラー・時間切れ | 145・5・0・0・0 |
| 想定内の失敗 | `callNext:queueEmpty` 1（列が空のとき）、`cancelTicket:cancelled` 5（キャンセルが反映されて画面を閉じ、応答を待たなかったもの。キャンセル自体は通っている） |
| 購読で受け取った件数 | board 9,166・整理券 747・列 1,609（計 11,522） |

**読み取りの見込み**: board は書き込みのたびに購読中の全員へ届くので、読み取りは「board の書き込み数 × 購読している人数」で増える。1組あたり board への書き込みは 発券・呼出・開始・完了の約4回。今回は 150組×約4回＝約600回の書き込みに対して board の受信が 9,166件で、平均およそ15人が同時に購読していた計算になる。当日は待ち時間が長く、整理券を持つ人（最大 約75人）が購読し続けるので、150組×4回×75人 ≒ 4.5万件まで増えうる。無料枠（5万/日）に近い。本番の負荷テストで関数側の読み取りも含めた実数を測る。

来場間隔を 0.15秒（実時間で30秒に1組）にして流すと、相談が追いつかず列が上限に達し、44組が発券できなかった（`full`）。上限で止まる動きそのものは正しい。

**Emulator での注意**: 発券・呼出・開始・完了はどれも、採番（`events/{eid}`）と `board/public` を読んでから書くトランザクション。2件が同時に走ると、本番は片方を中断して再試行するが、Emulator はロックの待ち合いになり、60秒の時間切れまで止まる。最初に同時に流したときは発券が70秒かかり、150組中1組しか完了しなかった（P2 の「20人同時で 8〜13秒」も同じ原因）。そこで Emulator では関数の呼び出しを1件ずつ順に流し、流れが正しいことだけを確かめる。同時に走ったときの速さ（再試行でどれだけ遅くなるか）は本番で測る。

ほかの Emulator（別の作業ツリーの `npm run emulators`）が動いているとポートがぶつかって起動できない。そのときは止めるか、ポートを変えた設定ファイルで `firebase emulators:exec --config <ファイル>` を使い、`LOAD_FUNCTIONS_PORT` で Functions のポートを渡す。

## 2. App Check と常駐台数

関数の設定は `functions/.env.<プロジェクト>`（git に入れる。秘密の値は書かない）で切り替える。変えたら関数をデプロイし直す。

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `ENFORCE_APP_CHECK` | `false` | callable 関数で App Check を強制する |
| `HOT_INSTANCES` | `0` | `issueTicket`・`callNext` の `minInstances`。開催日・リハーサル・本番の負荷テストの前に `1` にし、終わったら `0` に戻す（待機中も課金される） |

画面は `VITE_APPCHECK_SITE_KEY`（reCAPTCHA Enterprise のサイトキー）があるときだけ App Check を初期化する（`web/src/firebase.ts`）。Emulator では使わない。

**強制までの順番**（いきなり強制すると、トークンの付かない画面がすべて止まる）:

1. Google Cloud コンソールで reCAPTCHA Enterprise のキー（ウェブサイト、ドメインは `oc-ticket-2027.web.app` と公開 URL）を作る
2. Firebase コンソールの App Check で Web アプリに reCAPTCHA Enterprise を登録する
3. リポジトリ変数 `VITE_APPCHECK_SITE_KEY` を入れて画面をデプロイする
4. App Check の画面で Firestore・Storage・Functions の「確認済みのリクエスト」が大半になったのを確かめる
5. Firestore・Storage はコンソールで「適用」、関数は `ENFORCE_APP_CHECK=true` にしてデプロイ

負荷シナリオ（Node から呼ぶ）は App Check のトークンを持たない。本番の負荷テストは強制の前に行うか、その間だけ強制を外す。

## 3. デプロイ（GitHub Actions＋WIF）

`.github/workflows/deploy.yml`: PR ではテストだけを流す。main への push で、テスト（ユニット・ルール・関数・E2E・画面のビルド）を通してから `firebase deploy --project prod` する。手動実行（workflow_dispatch）では `--only` の対象を選べる。

準備（1回だけ）:

1. プロジェクトのオーナーの Google アカウントで `bash scripts/setup-wif.sh` を実行する。デプロイ用のサービスアカウント `github-deploy@` と WIF のプール・プロバイダを作る。**このリポジトリの main からのトークンだけ**を受け付ける
2. GitHub のリポジトリ変数（Variables。Secrets ではない）に登録する

   | 変数 | 値 |
   | --- | --- |
   | `GCP_WIF_PROVIDER`・`GCP_DEPLOY_SA` | `setup-wif.sh` の最後に表示される値 |
   | `VITE_FB_API_KEY`・`VITE_FB_AUTH_DOMAIN`・`VITE_FB_PROJECT_ID`・`VITE_FB_STORAGE_BUCKET`・`VITE_FB_APP_ID` | 手元の `web/.env.production` と同じ値（公開される設定値で、秘密ではない） |
   | `VITE_APPCHECK_SITE_KEY` | 2 の手順で作ったもの（まだなら空のまま） |

3. GitHub の Environments に `production` を作る（承認者を付ければ、デプロイの前に承認を挟める）

`GCP_WIF_PROVIDER` が未設定のうちはデプロイの job を飛ばす（テストだけ走る）。

デプロイ用のサービスアカウントのロールは `setup-wif.sh` に並べた。2026-11-27 の初回の自動デプロイ（関数を含む）で、App Engine の既定のサービスアカウント（`oc-ticket-2027@appspot.gserviceaccount.com`）への `iam.serviceAccounts.actAs` が足りず失敗したため、`roles/iam.serviceAccountUser` を足した。続けて `Permissions denied enabling cloudbilling.googleapis.com` で失敗したため、Cloud Billing API をプロジェクトの持ち主のアカウントで有効にする（どちらもスクリプトに追記）。

## 4. 本番での手順

### 本番の現在の状態（2026-11-26 07:20 UTC に読み取りで確認）

| 対象 | 状態 |
| --- | --- |
| 関数 | 19個が ACTIVE。2026-11-26 04:20 UTC に手元からデプロイ。中身は main（`d6f171a`）の `npm run build -w functions` と同じ（`lib/index.js` を突き合わせて確認） |
| 常駐台数 | `issueTicket`・`callNext` とも 0（`callNext` だけ 1 のまま残っていたので、07:17 UTC 頃に `--only functions:callNext` で戻した） |
| 画面（Hosting） | 2026-11-26 04:25・04:29 UTC に GitHub Actions の手動実行（`--only hosting`、`d6f171a`）でリリース。App Check のサイトキー入り |
| ルール | Firestore は 2026-11-26 04:19 UTC、Storage は 2026-11-23（どちらも main と同じ） |
| 索引 | 複合索引2件が READY |
| TTL | `tickets`・`visitors`・`staff`・`auditLog`・`rateLimits` の `expireAt` が ACTIVE。検証用の `verifyTtl` は 2026-11-26 に解除 |
| GitHub Actions | WIF のプール・プロバイダ（main からのトークンだけ受け付ける）、`github-deploy@`、リポジトリ変数、Environment `production` が設定済み |

- 以降の main への push は、テストを通ってから本番へ自動でデプロイされる

### 試用（2026-11-27）の準備

| 項目 | 状態 |
| --- | --- |
| 管理者 | 運営アカウント（運営ID＋パスワード、ロールあり）。最初のアカウントは `scripts/create-operator.mjs` で作る（下の「運営アカウント」）。以前のメール/パスワード＋TOTP の管理者は使えなくなる |
| イベント | `試用 2026-11-27`（`bxSVSE5CrZaabhjVUmaF`）。13:00 開場・15:00 閉場（JST、定期処理で自動）。16:00 に整理券などが消える |
| 枠 | 学生 テストA〜C（A-1〜A-3）、教員相談。コードは管理画面で発行済み |
| 匿名ログインの上限 | 1時間に1000件、2026-11-27 12:30〜16:30 JST（`quota.signUpQuotaConfig`） |

- 作成時に開場を 2025 年と入力し、定期処理がすぐ開場してしまった。開場時刻を直しても状態は戻らないため、入場・整理券が0件なのを確かめてから Admin SDK で `scheduled` に戻し、board を作り直した（監査ログには残らない）。その後、開催は24時間以内・閉場は今より後に限る検証を入れたが、不要との判断で 2026-11-27 に外した（開場時刻を未来へ変える戻し方は残してある）。開場中に開場時刻を未来へ変えると（入場・整理券がなければ）開場前に戻るよう直した（P2 の `createEvent` / `updateEvent`）

- App Check はサイトキーを画面に入れただけ。強制（`ENFORCE_APP_CHECK=true`、コンソールの「適用」）はまだ

### 手順

順番に行う。どれも本番を変えるので、行う前に確認する。

1. **関数・索引・TTL のデプロイ**（手元から）: `firebase deploy --project prod --only functions,firestore`。2026-11-24 に一度デプロイ済み。7.4-5 の TTL 計測は終わっている（合格）
2. **画面のデプロイ**: `firebase deploy --project prod --only hosting`（以降は GitHub Actions）
3. **匿名ログインの上限を一時的に上げる**（下の「匿名ログインの上限」）
4. **本番の負荷テスト**: `HOT_INSTANCES=1` でデプロイしてから

   ```bash
   gcloud auth application-default login   # Admin SDK がイベントを作るため
   cd verify
   LOAD_PROJECT=oc-ticket-2027 LOAD_CONFIRM=oc-ticket-2027 LOAD_API_KEY=<Web の API キー> npm run test:load
   ```

   開催中・開催予定のイベントがあると流さない（入場はいちばん早いイベントに入るため）。終わったら `HOT_INSTANCES=0` に戻す
5. **費用の計測**: 負荷テストの開始・終了時刻（結果の JSON にある）の間の読み書き件数を、Firebase コンソールの Firestore「使用状況」か Cloud Monitoring の `firestore.googleapis.com/document/read_count`・`write_count` で見る。数日後に請求レポートで東京の単価と、常駐1台の待機費用を確かめる（7.4-7）
6. 下の「本番でしか確かめられない項目」

### 匿名ログインの上限（重要）

Firebase Authentication は、**同じ IP アドレスからの新規登録（匿名を含む）を1時間に100件まで**に制限している（[Authentication Limits](https://firebase.google.com/docs/auth/limits)）。Firebase コンソールの Authentication の設定から、期間を決めて一時的に上げられる。

- 当日は来場者150組＋スタッフが匿名ログインする。会場の Wi-Fi（出口の IP が1つ）や、携帯回線の共有 IP（キャリアの NAT）に集まると、100件で止まるおそれがある。**開催日（とリハーサルの 3/5）は上限を上げておく**。運用準備の前日確認（3/19）の項目にも入れる
- 本番の負荷テストも1台の PC から150組以上を登録するので、上げてから流す

### 運営アカウント（管理者の認証。2026-11-27 に明学の質問箱と同じ方式へ）

管理者の認証は、Firebase のメール/パスワード＋TOTP をやめ、**運営ID＋パスワード＋ロール**にした（`meigaku-question-box` と同じ体系。仕様は [p2-functions.md](p2-functions.md)）。

- ログイン: 運営ID＋パスワード（15文字以上）→ `operatorLogin` がカスタムトークンを返す。8時間で切れる。ログイン試行は IP ごとに10分30回・運営IDごとに15分10回まで
- ロール: 開発者・責任者・教員・アンバサダー・スタッフ。開発者・責任者だけがアカウントを作成・再発行・停止・ロール変更できる（管理画面の「アカウント」）
- 以前のメール/パスワード＋TOTP の管理者（`admin` クレームのみ）は、ルール・関数が受け付けない。**切り替え前に、運営アカウントを CLI で作っておく**（下の手順）
- TOTP の必須は廃止（設計書 7.4-1 からの変更）。以下の「メールのリンク先」「初回設定で直したこと」は、TOTP 方式のときの記録

**切り替えの手順（順番が大切）**

1. 運営アカウントを作る（デプロイの前でもできる。Firestore に書くだけ）: `gcloud auth application-default login` のあと、`node scripts/create-operator.mjs --project oc-ticket-2027 --login-id <運営ID> --display-name <表示名> --role owner --execute`（仮パスワードは一度だけ出る）
2. 関数の実行サービスアカウントに `roles/iam.serviceAccountTokenCreator` を付ける（`createCustomToken` に必要。付けないと `operatorLogin` が `iam.serviceAccounts.signBlob` で失敗する）。コマンドは [p2-functions.md](p2-functions.md)
3. main にマージ → 自動デプロイ（ルール・関数・画面）
4. `/admin` で運営IDと仮パスワードでログイン → パスワードを変更 → 「アカウント」で職員のアカウントを作る
5. 古い Firebase のメール/パスワードの管理者ユーザーは、不要になったら Firebase コンソールで削除する

### メールのリンク先（2段階認証の取り消し。TOTP 方式のときの記録）

TOTP を登録すると、Firebase は登録したメールアドレスに「2段階認証を追加しました。心当たりがなければ取り消してください」というメールを送る（止められない）。標準の処理ページ（`<プロジェクト>.firebaseapp.com/__/auth/action`）は**リンクを開いただけで取り消しを実行する**。

2026-11-26、大学のメール（meijigakuin.ac.jp、Microsoft 365）で管理者を作ったところ、受信時に Microsoft の安全確認がこのリンクを自動で開き、登録の約20秒後に TOTP が取り消され、セッションも失効した。パスワードだけで入れて初回設定に戻るループになる。Identity Platform のリクエストログで、Microsoft のクラウドの IP から `ResetPassword`（リンクの確認）→ `SetAccountInfo`（取り消し）が届いていたことで分かった。`example.com` の検証用アカウントでは再現しない（メールが届かない）。

用意したもの: 開いただけでは何も送らず、「心当たりがないので取り消す」を押したときだけ `applyActionCode` を呼ぶページ `/auth-action`（`web/src/auth/AuthAction.tsx`、本番に出してある）。ただし**リンク先の切り替え（`notification.sendEmail.callbackUri`）は、API でも Firebase コンソールでも拒否された**（API は `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`、コンソールは「アクション URL の更新中にエラーが発生しました」。理由は不明）。切り替えられるようになったら `https://oc-ticket-2027.web.app/auth-action` にする。

当面の運用:

- 管理者のログイン ID は、リンクを自動で開かないメール（Gmail など）にする。2026-11-26 に運用アカウント（mga1863engineering@gmail.com）で管理者を作り直し、初回設定と TOTP ログインまで通った。大学のメールの管理者（24ms1009@meijigakuin.ac.jp）は 2026-11-27 に削除した
- 「2段階認証を追加しました」のメールのリンクは開かない（開くと取り消される）
- 大学のメールは管理者に使わない（Safe Links の除外は大学に相談しない。2026-11-27 に決定）

調べるときは Identity Platform のリクエストログ（設定 `monitoring.requestLogging.enabled`、Cloud Logging の `identitytoolkit_project`）を一時的に有効にすると、誰がどの呼び出しをしたか（IP・UA）が見える。終わったら無効に戻す（2026-11-26 に戻した）。

### 管理画面の初回設定で直したこと（2026-11-26）

- TOTP でログインした直後の最初の描画だけ「TOTP なし」になり、初回設定がパスワード変更の段階で固定されていた。`sign_in_second_factor` をクレームと同じトークンから取るようにした（`useAuthState` の `secondFactor`）
- TOTP 登録済みなのに TOTP を経ていないセッションでは、登録をやり直させず「ログインし直す」を案内する（以前は2つ目を登録しようとして `auth/maximum-second-factor-count-exceeded`）
- TOTP の登録画面に QR コードを出す（`qrcode` で端末の中で描く。秘密鍵を含むので外部のサービスには送らない）。読み取れないとき用にセットアップキーも残す（2026-11-27）
- Hosting が HTML を1時間キャッシュしていたため、修正を出しても最大1時間届かなかった。`firebase.json` で `Cache-Control: no-cache` にした（JS・CSS はファイル名にハッシュが入るので問題ない）

## 5. 画面のバンドル

| | 分割前 | 分割後 |
| --- | --- | --- |
| 来場者が読み込む JS | 912KB（gzip 274KB） | 858KB（gzip 261KB） |
| スタッフ画面 | 同上に含む | ＋16KB（gzip 5KB） |
| 管理画面 | 同上に含む | ＋41KB（gzip 12KB） |

残りのほとんどは Firebase SDK（Firestore・Auth・Functions・Storage・App Check）で、来場者も全部使う。分割の効果は小さいが、来場者は管理画面のコードを読み込まなくなった。読み込み時間は実機（P5）で測り、遅ければ Storage（画像）を後から読み込むなどを考える。

## 本番でしか確かめられない項目

P2・P3 で「本番で確かめる」とした項目。デプロイのあとに確かめる。

| 項目 | 出どころ |
| --- | --- |
| 匿名ログインが通り、メール/パスワードの新規登録がブロッキング関数で拒否される（エラーコード） | P2、`verify/src/e2e` |
| 運営アカウントのログイン（`operatorLogin` のカスタムトークンが本番で発行できる＝上の手順2）・初回のパスワード変更・ロール別の表示 | P3 |
| 閉場で購読が止まったときの表示（「本日の受付は終了しました」） | P3、7.4-4 |
| プロフィール画像の登録と `getBlob()` での表示（Storage ルールの `firestore.get()`） | P1・P3 |
| 発券・呼出の p95 ≦ 300ms、20組同時の発券 | P2 |
| 定期処理（開場・閉場・閉場＋1時間の削除） | P2 |
| 読み取り件数（無料枠 5万/日を超えるか）と費用 | 4章、7.4-7 |
