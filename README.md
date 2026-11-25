# オープンキャンパス個別相談 整理券システム

設計書: [docs/](docs/) ／ P0 の進み具合: [docs/p0-checklist.md](docs/p0-checklist.md) ／ P1 データモデル・ルール: [docs/p1-data-model.md](docs/p1-data-model.md) ／ P2 関数: [docs/p2-functions.md](docs/p2-functions.md) ／ P4 結合・負荷テスト・デプロイ: [docs/p4-integration.md](docs/p4-integration.md)

## 構成

| ディレクトリ | 内容 |
| --- | --- |
| `shared/` | 共有の型・定数・Firestore のパス |
| `functions/` | Cloud Functions（asia-northeast1） |
| `web/` | React + Vite の SPA |
| `scripts/` | 管理スクリプト（`create-admin.mjs`: 管理者の作成・無効化、`setup-wif.sh`: デプロイ用の WIF の設定） |
| `verify/` | ルールテスト（`p1-rules.test.ts`）、関数のテスト（`p2/`、`e2e/`）、本番検証のスクリプト |

## 開発

```bash
npm install
npm run emulators        # Emulator 一式（UI: http://127.0.0.1:4000）
npm run dev -w web       # 画面（http://localhost:5173）
npm run test:rules       # Firestore・Storage ルールのテスト（Emulator）
npm run test:functions   # 関数の本体のテスト（Firestore・Auth Emulator）
npm run test:e2e         # callable とブロッキング関数の E2E（Functions Emulator）
npm run test:load        # 150組の負荷シナリオ（Functions Emulator。本番は docs/p4-integration.md）
```

Emulator は `demo-numbered-ticket` プロジェクトで動くため、本番にはつながりません。

## 既知の課題

- 関数のランタイムは nodejs22 指定。ローカルは Node 24 で動かしている（警告のみ）。
