# 在庫管理 Web版（ZaikoOnWeb）

社内LAN専用の在庫管理。本アプリを実行するPC（以降「サーバーPC」。Windows）で Node.js サーバーを動かし、PC・スマホのブラウザから使う。
利用者は日本語話者。画面の文言・コメント・コミットメッセージは日本語。

## 構成
- `server/src` … Fastify 5 + node:sqlite（DatabaseSync, WAL）。`inventory.ts` が業務ロジックの中心、`app.ts` が API、`main.ts` が起動・定期処理
- `server/src/db.ts` … マイグレーション（PRAGMA user_version）。**既存の項目は書き換えず、配列の末尾に追加する**。CHECK 制約の変更はテーブル作り直し
- `web/src` … React 19 + Vite。PC 画面（`pages/`）とスマホ画面（`mobile/`, URL は `/m`）
- `shared/` … サーバーと画面で共通の型（`types.ts` の `Rules` に上限値）・文字列処理
- `e2e/e2e.cjs` … Playwright による画面の自動テスト（偽カメラ・SMTP の受け口つき）
- `scripts/` … ビルド（ビルド日時がバージョン）、サーバーPCでの更新（`update.mjs`）

## コマンド
```
npm ci
npm run typecheck
npm test          # vitest（server/test, web/src/**/*.test.ts）
npm run build     # 型チェック → dist/（server.mjs 1ファイル + web/）
npm run e2e       # build 後に実行
npm run dev       # 開発用（画面 5173 / API 28003）
```
変更後は `npm test` と `npm run build` が通ること。画面を変えたら `npm run e2e` も。

## 守ること
- `data/`（DB・商品写真・紐づけIDリスト link-ids.txt・メール設定）と `dist/` はコミットしない（.gitignore 済み）。顧客名などの実データをテストやコードに入れない
- data に作るファイル・フォルダの名前は英語にする（日本語名は zip の展開などで文字化けしやすい）
- `.bat` は **ASCII のみ・改行 CRLF**（日本語を入れるとサーバーPCで文字化けする）
- 待ち受けポートの既定値は 28003。bat には直接書かず、`load-settings.bat` が既定値を設定し、サーバーPCごとの `settings.bat`（.gitignore 済み、見本は `settings.example.bat`）で上書きする。既定値は `load-settings.bat` / `settings.example.bat` / `server/src/main.ts` でそろえる（`server/test/batFiles.test.ts` で確認）
- 社内LANからの接続だけを受け付ける（`network.ts` の判定を緩めない）
- 入力値は境界値・形式を検証し、エラーは日本語で何を直せばよいか分かる文にする
- 履歴は消さない（修正は history_edits に記録、取消は逆向きの CANCEL 履歴）

## サーバーPCへの反映
サーバーPCで `update.bat`（git pull → npm ci → build → サーバー再起動）。README の「GitHub から更新する」を参照。
