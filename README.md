# オープンキャンパス個別相談 整理券システム

設計書: [docs/](docs/) ／ P0 の進み具合: [docs/p0-checklist.md](docs/p0-checklist.md)

## 構成

| ディレクトリ | 内容 |
| --- | --- |
| `shared/` | 共有の型・定数 |
| `functions/` | Cloud Functions（asia-northeast1） |
| `web/` | React + Vite の SPA |
| `verify/` | ルールテストと 7.4 の検証 |

## 開発

```bash
npm install
npm run emulators        # Emulator 一式（UI: http://127.0.0.1:4000）
npm run dev -w web       # 画面（http://localhost:5173）
npm run test:rules       # ルールのテスト
```

Emulator は `demo-numbered-ticket` プロジェクトで動くため、本番にはつながりません。

## 既知の課題

- `functions` は `@nt/shared` をワークスペース参照しているため、このままではデプロイできない。P2 でバンドル（esbuild 等）にする。
- 関数のランタイムは nodejs22 指定。ローカルは Node 24 で動かしている（警告のみ）。
