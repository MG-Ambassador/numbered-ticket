# P0 準備・技術検証 チェックリスト

完了条件: 設計書 7.4 の検証がすべて終わり、設計の修正点が確定していること。

## A. ローカル環境（完了 2026-11-15）

- [x] リポジトリの雛形（npm workspaces: `shared` / `functions` / `web` / `verify`）
- [x] `firebase.json`（Firestore・Functions・Auth・Storage・Hosting の Emulator、リージョン asia-northeast1）
- [x] `.firebaserc` は `demo-numbered-ticket`（`demo-` で始まるため、Emulator は本番に一切つながらない）
- [x] 仮ルール（クライアントの読み書きを全拒否）
- [x] 画面から「匿名ログイン → callable 関数」の疎通を Emulator で確認
- [x] 7.4 の検証のうち Emulator でできるもの（`npm run test:rules`）→ 結果は [p0-verification.md](p0-verification.md)

## B. 本番プロジェクトの準備（完了 2026-11-21）

カード登録・アカウントのセキュリティ設定は本人、それ以外は Claude が Chrome で操作。

- [x] **大学の外部クラウド利用申請を提出**（承認済み。運用用の Google アカウントあり）
- [x] 請求先はカード（請求先アカウント「Firebase のお支払い」、通貨 JPY）
- [x] 運用アカウントの2段階認証を有効化（Firebase コンソールの利用に必須）
- [x] Firebase プロジェクト `oc-ticket-2027` を作成（アナリティクス・Gemini・デベロッパー プログラムはオフ）
- [x] Blaze に切り替え
- [x] 予算アラート ¥1,000/月（¥500・¥900・¥1,000 で通知）。サービスレベルの利用額上限（自動停止）は設定しない
- [x] Identity Platform にアップグレード（元に戻せない）
- [x] Firestore `(default)` を asia-northeast1、Standard エディション、本番環境モードで作成（バックアップなし）
- [x] Storage `oc-ticket-2027.firebasestorage.app` を ASIA-NORTHEAST1、本番環境モードで作成
- [x] `.firebaserc` に `prod: oc-ticket-2027` を追加
- [x] `firebase login --reauth` を運用アカウントで実行（2026-11-23。CLI から `oc-ticket-2027` が見えることを確認）
- [x] Authentication のログイン方法（匿名、メール/パスワード）、TOTP、パスワードポリシーを設定

## C. 本番プロジェクトができてから行う 7.4 の検証

Emulator では本番と同じ結果にならない項目です。手順は [p0-verification.md](p0-verification.md) を参照。

- [x] 7.4-1 実際の TOTP ログインのトークンに `sign_in_second_factor: 'totp'` が入るか → 入る
- [x] 7.4-2 TOTP 登録に `emailVerified: true` が必要か → 必要で、それで足りる
- [x] 7.4-3 callable 関数で実 IP が取れるか → X-Forwarded-For の末尾で取れる（req.ip は偽装可）
- [x] 7.4-4 購読中の閉場 → 本番では15秒以内に permission-denied で止まる
- [ ] 7.4-5 Firestore TTL の削除が24時間以内か → 計測中（2026-11-24 02:41 UTC 以降に確認）
- [x] 7.4-6 新規登録の無効化 → 匿名も止まるので不可（ブロッキング関数で代替）。パスワードポリシー → 可
- [ ] 7.4-7 料金 → 無料枠は確認。東京の単価は P4 の請求レポートで確認
