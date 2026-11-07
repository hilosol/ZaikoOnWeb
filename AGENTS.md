# AGENTS.md — AI アシスタント向けの作業ルール（ZaikoOnWeb）

このファイルは、このリポジトリで作業する AI（Claude Code / GitHub Copilot / Codex / Cursor など）向けの共通ルールです。
人向けの使い方は `README.md`、これまでの経緯・設計判断・残課題は `docs/HANDOVER.md` を読んでください。

## このアプリ
社内LAN専用の在庫管理。本アプリを実行するPC（以降「サーバーPC」。Windows）で Node.js サーバーを動かし、PC・スマホのブラウザから使う。
利用者は日本語話者。**画面の文言・コメント・コミットメッセージは日本語**。

## 構成
- `server/src` … Fastify 5 + node:sqlite（DatabaseSync, WAL）
  - `inventory.ts` 業務ロジックの中心 / `app.ts` API / `main.ts` 起動・定期処理（1時間ごと）
  - `db.ts` マイグレーション（PRAGMA user_version）。**既存の項目は書き換えず、配列の末尾に追加する**。CHECK 制約の変更はテーブル作り直し
  - `backup.ts` 自動バックアップ / `updater.ts` 画面からの更新 / `presence.ts` 編集中の表示 / `mail/` メール通知 / `logExport.ts` 履歴CSVの月別保存
- `web/src` … React 19 + Vite。PC 画面（`pages/`, `history/`）とスマホ画面（`mobile/`, URL は `/m`）
- `shared/` … サーバーと画面で共通の型（`types.ts` の `Rules` に上限値）・文字列処理（`text.ts`）
- `e2e/e2e.cjs` … Playwright による画面の自動テスト（偽カメラ・SMTP の受け口つき）
- `scripts/` … ビルド（ビルド日時がバージョン）、サーバーPCでの更新（`update.mjs`）、デモデータ（`seed-demo.ts`）
- ルートの `*.bat` … サーバーPC用（起動・自動起動の登録・更新・GitHub 接続）

## コマンド
```
npm ci
npm run typecheck
npm test          # vitest（server/test, web/src/**/*.test.ts）
npm run build     # 型チェック → dist/（server.mjs 1ファイル + web/）
npm run e2e       # build 後に実行（Playwright と Chromium が必要: npx playwright install chromium）
npm run dev       # 開発用（画面 5173 / API 28003）
```
**変更後は `npm test` と `npm run build` が通ること。画面を変えたら `npm run e2e` も。**
E2E はまれに1件だけタイミングで落ちることがある（毎回違う項目）。落ちた項目が今回の変更と無関係なら再実行して確認する。

## 守ること
- `data/`（DB・商品写真・紐づけIDリスト link-ids.txt・メール設定・GitHub トークン）と `dist/` はコミットしない（.gitignore 済み）
- 顧客名などの**実データをテストやコードに入れない**（テストは架空のデータ）
- data に作るファイル・フォルダの名前は英語にする（日本語名は zip の展開などで文字化けしやすい）
- `.bat` は **ASCII のみ・改行 CRLF**（日本語を入れるとサーバーPCで文字化けする）。生成するときはバイト列で書く
- 待ち受けポートの既定値は 28003。bat には直接書かず、`load-settings.bat` が既定値を設定し、サーバーPCごとの `settings.bat`（.gitignore 済み、見本は `settings.example.bat`）で上書きする。既定値は `load-settings.bat` / `settings.example.bat` / `server/src/main.ts` でそろえる（`server/test/batFiles.test.ts` で確認）
- ローカルネットワーク（社内LAN）からの接続だけを受け付ける（`network.ts` の判定を緩めない）
- 入力値は境界値・形式を検証し、エラーは日本語で**何を直せばよいか分かる文**にする
- 履歴は消さない（修正は history_edits に記録、取消は逆向きの CANCEL 履歴）
- 設定の変更は操作ログ（audit_logs, SETTINGS_CHANGE）に残す
- 画面からの更新・その状態は**サーバーPCの画面にだけ**出す（他の端末には存在も見せない）

## 用語（画面の表記をそろえる）
| 画面の表記 | 内部の名前 | 補足 |
|---|---|---|
| サーバーPC | — | 本アプリを実行するPC。「共有PC」とは書かない |
| 商品ID | `code` | 旧称「商品コード」。旧ID／新ID、ID変更 |
| 紐づけID（受注番号等） | `orderNo` | 旧称「受注番号」 |
| ローカルネットワーク | — | 「社内ネットワーク」とは書かない |
| 入庫・移管・出庫 | IN / TRANSFER / OUT | PC・スマホとも左から 出庫・移管・入庫 |
| 簿外 | `offBook` | 帳簿に載せていない在庫 |

## 依頼者（利用者）の方針
- 挨拶・前置き・お世辞は不要。分からないことは推測せず「分からない」と言う
- **プログラムの変更は指示されたときだけ**。それ以外は修正案を示す（メリット・デメリットと、より良い案があれば添える）
- 例外処理・エラー処理・入力チェック・境界値を必ず考える
- 読みやすく、拡張しやすく、テストしやすい、疎結合なコードにする
- 新しい GitHub リポジトリは Private にする
- 依頼者は LAMP 環境は分かるが Node.js にはあまり詳しくない。説明はその前提で

## サーバーPCへの反映
サーバーPCで `update.bat`（git pull → npm ci → build → サーバー再起動）、またはサーバーPCの画面の「プログラムの更新」。README の「GitHub から更新する」を参照。
GitHub につながっていない場合は、`dist` を含めた zip（`git archive` だけでは dist が入らないので注意）を渡して上書きしてもらう。
