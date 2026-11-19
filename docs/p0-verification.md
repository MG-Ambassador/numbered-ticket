# 設計書 7.4 の検証結果

検証コード: `verify/src/p0-rules.test.ts`、`functions/src/index.ts`（`verifyIp`）
実行: `npm run test:rules`（Firestore Emulator）

| # | 項目 | Emulator での結果（2026-11-15） | 本番での確認 | 設計への影響 |
| --- | --- | --- | --- | --- |
| 1 | ルールで `sign_in_second_factor == 'totp'` を判定できるか | **判定できる**。totp は読める、第2要素なしと phone は拒否 | 未。Emulator はトークンを模擬しているだけなので、実際の TOTP ログインのトークンにこの値が入るかを確認する | 確認できればなし |
| 2 | TOTP 登録に `emailVerified: true` が必要か | 未検証（Auth Emulator は TOTP MFA を再現できない） | 未。管理者アカウントを Admin SDK で作り、`emailVerified` の有無で登録を試す | 必要なら管理者作成スクリプトで `emailVerified: true` を設定する |
| 3 | callable 関数で実 IP が取れるか | Emulator では `ip: null`（本番の判断材料にならない） | 未。`verifyIp` をデプロイし、スマホ回線から呼んで `ip` と `x-forwarded-for` を見る | 取れなければ IP ごとの試行制限（V-01）を端末ごとのみにする |
| 4 | 購読中に閉場したときルールが再評価されるか | **events を closed にしただけでは何も起きない**。購読中のドキュメントが次に更新された時点で `permission-denied` になり購読が止まる | 未。本番でも同じ挙動か確認する | 閉場処理で `board/public` と各整理券を必ず更新する（整理券の expired 化・問診メモ削除で更新が入るので、設計どおりで足りる見込み） |
| 5 | Firestore TTL の削除が24時間以内か | 未検証（Emulator は TTL 非対応） | 未。TTL ポリシーを設定してテスト用ドキュメントで計測する | 24時間を超えるなら、閉場+1時間の物理削除は関数で行う（設計どおり）。TTL は保険扱い |
| 6 | Identity Platform で新規登録無効化・パスワードポリシーを設定できるか | 未検証（コンソールの設定項目） | 未 | 不可なら `beforeUserCreated` ブロッキング関数で拒否する |
| 7 | 料金の単価と無料枠 | 未 | 未。公式の料金ページで確認 | 予算 $25 に収まるか P4 の計測と照合 |

## 補足

- 7.4-4 の Emulator でのログ:
  `["snapshot n=0", "--- events/e1 を closed に変更", "--- verifyLive/a を更新", "error permission-denied"]`
- 検証用のルール（`/verify/mfa`、`/verifyLive/{id}`）と `verifyIp` 関数は P0 専用。P1・P2 で削除する。
