# P3 画面の実装

完了条件（設計書 6章）: Emulator 上で発券から完了までを画面で一巡できる → **一巡できた**（2026-11-25。入場（QR）→ 発券 → 呼出 → いま向かいます → 相談開始 → 完了、と 不在 → 復帰 を画面で確認）。管理画面も Emulator で、イベント作成・CSV 取込（誤りの行の表示を含む）・画像登録・コード表示・強制解除・全体停止・統計を確認

| 順 | 範囲 | 状態 |
| --- | --- | --- |
| 1 | 来場者（V-01〜V-08）: 入場ゲート・相談の選択と発券・整理券モニター・呼出通知 | **済**（2026-11-25） |
| 2 | スタッフ（S-01〜S-09）: ログイン・担当設定・列の操作 | **済**（2026-11-25） |
| 3 | 管理者（A-01〜A-07）: ログイン＋TOTP・イベント設定・コード・枠の管理・当日の操作・統計 | **済**（2026-11-25）。TOTP と初回設定は Emulator で試せないため本番で確認（P4） |

| 成果物 | ファイル |
| --- | --- |
| 入口・画面の振り分け | `web/src/main.tsx` |
| 来場者 | `web/src/visitor/VisitorApp.tsx`, `Gate.tsx`, `Slots.tsx`, `Ticket.tsx` |
| スタッフ | `web/src/staff/StaffApp.tsx`, `Queue.tsx` |
| 管理者 | `web/src/admin/AdminApp.tsx`（ログイン・初回設定）, `session.ts`, `Console.tsx`, `Today.tsx`, `EventForm.tsx`, `Codes.tsx`, `SlotsAdmin.tsx`, `Stats.tsx` |
| 共通（購読・callable・部品・見た目） | `web/src/lib/hooks.ts`, `web/src/lib/api.ts`, `web/src/ui.tsx`, `web/src/styles.css` |
| 目安時間・コードの区切り | `shared/src/display.ts`（テスト `verify/src/p3/display.test.ts`、`npm run test:unit`） |
| Emulator のデータ投入 | `scripts/seed-emulator.mjs`（`npm run seed`） |

## 画面で確かめる手順

```bash
npm run emulators
```

```bash
npm run seed
```

```bash
npm run dev
```

- 来場者: http://localhost:5173/#code=0384712 （または http://localhost:5173/ で 038-4712）
- スタッフ: http://localhost:5173/staff （0384-7125、学生スタッフ → 枠を選ぶ）
- 管理者: http://localhost:5173/admin （admin@example.com / dev-admin-password。`npm run seed` が Auth Emulator に作る）
- `npm run seed` は Firestore を空にしてから、開場中のイベント `dev`（学生枠 5・教員相談）を作る。開場前を見るときは `node scripts/seed-emulator.mjs --reset --state scheduled`

## 決めたこと

### 1. 画面の種類ごとに Firebase のアプリを分ける

`clients('visitor' | 'staff' | 'admin')` で名前付きのアプリを作り、匿名ユーザーとクレームを別々に保存する。1つのアプリだと、同じブラウザで来場者とスタッフの画面を開いたときにクレームが上書きされる（開発中の確認でも、当日にスタッフが自分の端末で一覧を見るときも困る）。

### 2. 目安時間の計算（V-02・V-04）

`estimateWaitMinutes(board の枠, 前の組数)`。空いているブースの数より前の組が少なければ「まもなく」、それ以外は「何巡目か × 平均相談時間」を5分単位に切り上げる。平均相談時間は board の `avgConsultSeconds`（直近10件の実績、なければ `consultMinutes`）。モックアップの計算と同じ結果になる。

### 3. 呼出通知（V-05）

- 状態が `calling` になったら全画面バナー・タブ名「【呼出】No.○」・振動（Android）・音（「音で知らせる」をオンにしたときだけ。iOS は利用者の操作の中で `AudioContext` を作らないと鳴らないため、オンにした時点で作る）
- 「いま向かいます」で `markArriving` を呼び、バナーを閉じる。スタッフの画面には「向かっています」と出る。復帰して呼ばれ直したら、またバナーを出す（`calledAt` で区別）
- 画面を閉じる・ロックすると届かないことを、待っている間ずっと表示する

### 4. 整理券の画面は「最後に見ていた整理券」を覚える

入場記録の `activeTicketId` は完了・キャンセルで消えるので、それだけでは「ありがとうございました」を出せない。見ている整理券の ID を `localStorage` に置く（ID だけで個人情報は含まない。読めるのはルールで本人だけ）。

### 5. スタッフの5秒の取り消し（S-06）

完了・不在は押してから5秒待って送る。その間は［取り消す］を出す。画面を離れたときは待たずに送る。

### 6. 文字の大きさ

設計書 4章「文字16px 以上」に合わせ、本文を 16px にした（モックアップは 15px）。補足の文字（目安の注記など）は 12〜14px のまま。

### 7. 管理画面は Emulator では TOTP を省略する

Auth Emulator は TOTP に対応していない（登録で `Missing phoneEnrollmentInfo`）。管理者の関数とルールは「TOTP 済みのトークン」を必須にしているので、そのままでは Emulator で管理画面を試せない。関数とルールは変えずに、**画面の側で Emulator のときだけ**次のようにする（`web/src/admin/session.ts`）。

- パスワードでログインしたユーザーの uid に `admin: true` と `firebase.sign_in_second_factor: 'totp'` を付けた署名なしのトークンを作る
- Firestore・Storage は `mockUserToken` で、`adminApi` は `fetch` でそのトークンを渡す
- Emulator は署名を確かめないので通る。本番は署名を確かめるので、この経路は本番では通らない（本番のビルドでは `useEmulator` が false で、呼ばれない）
- 初回設定（パスワード変更・TOTP 登録・`completeSetup`）は Emulator ではできないので、`npm run seed` の管理者は `initial` なしで作る。初回設定と TOTP ログインは本番で確かめる（P4）

### 8. 管理画面の操作

- 日時は JST で入力・表示する（`datetime-local` の値に `+09:00` を付けて送る）。管理者の端末のタイムゾーンに左右されない
- 開場・閉場・全体停止・強制解除・コードの作り直し・枠の削除は確認を挟む。閉場は「元に戻せない」と書く
- コードは［表示する］を押したときだけ取りに行く（表示も auditLog に残るため）。ポスターの QR は URL を出してコピーできるようにした（QR の画像は作っていない）
- ログインの記録（`recordLogin`）は、開いたイベントごとに1回送る（auditLog はイベントの下にあるため）
- 担当の「最終確認」（`staff.lastSeenAt`）が3分より古いと注意の色にする。強制解除の判断に使う
- 画像は長辺 400px の JPEG に縮小してから送る（512KB を超えたら画質を下げてやり直す）
- CSV は「今の枠を書き出す」で今の内容を出し、直して取り込み直せる。誤りは行と列を並べて出す

## まだ決めていない・あとでやること

- 管理者の初回設定（パスワード変更・TOTP 登録）と TOTP でのログインを本番で確かめる（P4）
- ポスター用の QR の画像（いまは URL のみ。印刷会社に URL を渡すか、画像も作るかを入稿前に決める）
- 閉場で購読がルールで止まったときの表示（「本日の受付は終了しました」）は、本番（15秒以内に止まる）で P4 に確かめる。Emulator では次の更新まで止まらない（7.4-4）
- プロフィール画像の登録と `getBlob()` での表示は Emulator で確認済み。本番の Storage ルール（`firestore.get()` の権限、P1）での確認は P4
- バンドルが 500KB を超える（Firebase SDK）。来場者とスタッフ・管理者で分けるかは P4 で読み込み時間を測ってから決める
- Wake Lock は iOS Safari 16.4 以上で使える。使えない端末では「端末の設定で自動ロックを長く」と案内する。実機の確認は P5
