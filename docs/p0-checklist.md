# P0 準備・技術検証 チェックリスト

完了条件: 設計書 7.4 の検証がすべて終わり、設計の修正点が確定していること。

## A. ローカル環境（完了 2026-11-15）

- [x] リポジトリの雛形（npm workspaces: `shared` / `functions` / `web` / `verify`）
- [x] `firebase.json`（Firestore・Functions・Auth・Storage・Hosting の Emulator、リージョン asia-northeast1）
- [x] `.firebaserc` は `demo-numbered-ticket`（`demo-` で始まるため、Emulator は本番に一切つながらない）
- [x] 仮ルール（クライアントの読み書きを全拒否）
- [x] 画面から「匿名ログイン → callable 関数」の疎通を Emulator で確認
- [x] 7.4 の検証のうち Emulator でできるもの（`npm run test:rules`）→ 結果は [p0-verification.md](p0-verification.md)

## B. 手作業（本人が行う。Claude は代行しない）

権限・請求・規約同意を伴うため、以下は本人が行ってください。

- [x] **大学の外部クラウド利用申請を提出**（承認済み。運用用の Google アカウントあり）
- [ ] 請求先アカウントの利用可否を確認（Blaze に必要。決まらないと本番環境を作れない）
- [ ] `firebase login --reauth`（CLI の認証が切れている。Emulator だけなら不要）
- [ ] GCP 専用プロジェクトを作成（例: `oc-ticket-2027`。東京リージョン）
- [ ] Firebase を追加し、Blaze に切り替え
- [ ] 予算アラート ¥1,000/月（50・90・100% で通知）を設定
- [ ] Identity Platform にアップグレード（TOTP MFA に必要）
- [ ] Firestore を asia-northeast1 で作成（PITR は有効にしない）
- [ ] 作成後、プロジェクト ID を伝えてもらえれば `.firebaserc` に `prod` エイリアスを追加する

## C. 本番プロジェクトができてから行う 7.4 の検証

Emulator では本番と同じ結果にならない項目です。手順は [p0-verification.md](p0-verification.md) を参照。

- [ ] 7.4-1 実際の TOTP ログインのトークンに `sign_in_second_factor: 'totp'` が入るか
- [ ] 7.4-2 TOTP 登録に `emailVerified: true` が必要か、それで足りるか
- [ ] 7.4-3 callable 関数で実 IP が取れるか（`verifyIp` をデプロイして確認）
- [ ] 7.4-4 購読中の閉場（本番でも Emulator と同じ挙動か）
- [ ] 7.4-5 Firestore TTL の削除が24時間以内か
- [ ] 7.4-6 Identity Platform で新規登録の無効化とパスワードポリシーを設定できるか
- [ ] 7.4-7 料金ページで単価と無料枠を確認
