# 🌲 材木店 LINE管理ダッシュボード

LINEメッセージで在庫・発注・請求書を管理するデモシステムです。  
Node.js + LINE Messaging API + SQLite + Google Sheets/Gmail 連携。

---

## 目次

1. [必要環境](#必要環境)
2. [クイックスタート](#クイックスタート)
3. [LINEコマンド一覧](#lineコマンド一覧)
4. [Google Sheets 連携設定](#google-sheets-連携設定)
5. [Gmail 送信連携設定](#gmail-送信連携設定)
6. [管理画面](#管理画面)
7. [ディレクトリ構成](#ディレクトリ構成)

---

## 必要環境

| ツール | バージョン |
|---|---|
| Node.js | v20以上（推奨 v24） |
| ngrok | 最新版 |
| LINEアカウント | Messaging API チャンネル |

---

## クイックスタート

```bash
# 1. 依存パッケージインストール
npm install

# 2. 環境変数ファイル作成
cp .env.example .env
# .env を編集して LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET を設定

# 3. サーバー起動
node src/server.js

# 4. ngrok でトンネル作成（別ターミナル）
ngrok http 3000

# 5. LINE Developers でWebhook URLを設定
# https://developers.line.biz/ → チャンネル → Messaging API → Webhook URL
# 例: https://xxxx.ngrok-free.app/webhook
```

---

## LINEコマンド一覧

### 在庫管理

| コマンド | 説明 |
|---|---|
| `在庫確認` | 全品目の在庫一覧（Flex Message） |
| `在庫 杉板` | キーワードで品目検索 |
| `入庫 杉板 100` | 指定品目を入庫 |
| `出庫 杉板 50` | 指定品目を出庫（フローなし） |
| リッチメニュー「⬇️ 出庫」 | 品目選択 → 数量入力 → 確認の対話フロー |

### 発注管理

| コマンド | 説明 |
|---|---|
| `発注確認` | 承認待ち発注一覧 |
| `発注 杉板2×4 100枚 山田製材所` | 発注作成 |
| `承認 1` | 発注ID=1 を承認 |
| `却下 1` | 発注ID=1 を却下 |

### 請求書

| コマンド | 説明 |
|---|---|
| `請求書作成 田中建設 2024年12月` | 出庫履歴から自動集計してPDF生成 |
| `請求書作成 田中建設 杉板 100枚 角材 30本` | 品目を手動指定してPDF生成 |
| `請求書送付 田中建設 2024年12月` | 顧客のLINE IDへ直送 |
| `請求書メール送付 田中建設 INV-20241201-001` | 顧客のメールアドレスへPDF添付送信 |
| `入金確認 INV-20241201-001` | 請求書番号で入金フラグをON（Sheets自動更新） |
| `未払い確認` | 未払い請求書一覧 |
| `月次レポート送信` | 当月サマリーをGmailで管理者に送信 |

### 見積書・納品書

| コマンド | 説明 |
|---|---|
| `見積書 田中建設 杉板2×4 50枚` | 見積書PDF生成 |
| `納品書 田中建設 杉板2×4 30枚` | 納品書PDF生成（在庫自動減算） |

### 棚卸し

| コマンド | 説明 |
|---|---|
| `棚卸し開始` | 棚卸しモード開始（全品目リスト表示） |
| `棚卸し 杉板 45` | 品名キーワードと実地数量を入力 |
| `棚卸し完了` | 差異サマリー → 「反映する」でDB・Sheets更新 |
| `棚卸し完了 強制` | 未入力品目があっても完了 |
| `棚卸しキャンセル` | 棚卸しモード中断 |
| `棚卸し履歴` | 直近10件の調整履歴 |

### その他

| コマンド | 説明 |
|---|---|
| `掛け率 田中建設` | 顧客の掛け率を確認 |
| `掛け率 田中建設 0.80` | 掛け率を変更 |
| `材積 105 105 3000 10` | 材積計算（幅×高さ×長さ 本数） |
| `ヘルプ` | 操作メニュー表示 |

### 受注管理

| コマンド | 説明 |
|---|---|
| `受注登録 田中建設 杉板2×4 100枚 檜角材 50本` | 受注を登録して受注番号を発行 |
| `受注一覧` | 未完了の受注一覧（Flex Message） |
| `受注確認 ORD-20260522-001` | 受注詳細とステータスを確認 |
| `出荷伝票 ORD-20260522-001` | 出荷伝票PDFを生成 |

### 配達管理

| コマンド | 説明 |
|---|---|
| `配達登録 ORD-20260522-001 明日午前` | 配送予定を登録 |
| `配達一覧` | 直近の配送予定一覧 |
| `今日の配達` | 本日の配送予定のみ表示 |
| `配達完了 ORD-20260522-001` | 配送を完了して受注を「配達済」に更新 |

### 検収

| コマンド | 説明 |
|---|---|
| `検収開始 1` | 発注ID=1 の検収Flexを表示 |
| `検収OK 1` | 発注ID=1 を検収OK→入庫処理を実行 |
| `検収NG 1 数量不足` | 発注ID=1 を検収NG→理由を記録 |

### デモ

| コマンド | 説明 |
|---|---|
| `デモ開始` | 業務フロー全体のデモ操作ガイドを表示 |

---

## Google Sheets 連携設定

### 概要

在庫・発注・請求書・棚卸しの更新を自動でGoogle Sheetsに同期します。  
設定しない場合は全機能がそのまま使えます（Sheets連携のみ無効）。

---

### 手順 1: Google Cloud プロジェクト作成

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. 上部の「プロジェクトを選択」→「新しいプロジェクト」
3. プロジェクト名を入力（例: `lumber-line-demo`）→「作成」

---

### 手順 2: Google Sheets API を有効化

1. 左メニュー「APIとサービス」→「ライブラリ」
2. 検索欄に「Google Sheets API」と入力
3. 「Google Sheets API」をクリック →「有効にする」

---

### 手順 3: サービスアカウント作成

1. 左メニュー「APIとサービス」→「認証情報」
2. 「認証情報を作成」→「サービスアカウント」
3. サービスアカウント名を入力（例: `lumber-sheets-sync`）→「作成して続行」
4. ロールは「基本」→「編集者」を選択 →「続行」→「完了」

---

### 手順 4: JSONキーをダウンロード

1. 「認証情報」一覧からサービスアカウントをクリック
2. 「キー」タブ →「鍵を追加」→「新しい鍵を作成」
3. 形式「JSON」を選択 →「作成」（JSONファイルが自動ダウンロード）
4. ダウンロードしたJSONの中身を確認：

```json
{
  "type": "service_account",
  "project_id": "your-project",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n",
  "client_email": "lumber-sheets-sync@your-project.iam.gserviceaccount.com"
}
```

5. `.env` に以下を転記：

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=lumber-sheets-sync@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n
GOOGLE_SPREADSHEET_ID=（手順 5 で取得）
```

> ⚠️ `GOOGLE_PRIVATE_KEY` はJSONの `private_key` の値を **1行で** そのままペーストしてください。
> `\n` は文字列として残して構いません（コード内で `replace(/\\n/g, '\n')` で自動変換します）。

---

### 手順 5: スプレッドシート作成と共有

1. [Google スプレッドシート](https://sheets.google.com/) で新規スプレッドシートを作成
2. URLの `/d/` と `/edit` の間の文字列が **スプレッドシートID**
   ```
   https://docs.google.com/spreadsheets/d/ [ここ] /edit
   ```
3. `.env` に設定：
   ```env
   GOOGLE_SPREADSHEET_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms
   ```
4. スプレッドシートの「共有」ボタン →「ユーザーやグループを追加」
5. `GOOGLE_SERVICE_ACCOUNT_EMAIL` のアドレスを入力 → 権限「編集者」→「送信」

---

### 自動で作成されるシート構成

サーバー起動時に以下の4シートが自動作成されます：

| シート名 | 主な列 | 更新タイミング |
|---|---|---|
| 在庫台帳 | 品目ID・品名・規格・現在庫数・単価・発注点・最終更新 | 入庫・出庫・棚卸し時（発注点以下は赤背景） |
| 発注記録 | 発注ID・品名・数量・仕入先・状態・承認日時 | 発注作成・承認・却下時 |
| 請求管理 | 請求書番号・顧客名・合計額・消費税・入金状態・入金日 | 請求書作成・入金確認時 |
| 棚卸し履歴 | 実施日・品目名・システム在庫数・実数・差分 | 棚卸し反映時 |

---

## Gmail 送信連携設定

### 概要

請求書PDFのメール送付・在庫アラート・月次レポートの自動送信ができます。  
設定しない場合は全機能がそのまま使えます（メール機能のみ無効）。

---

### 手順 1: Google Cloud で Gmail API を有効化

1. Google Cloud Console → 「APIとサービス」→「ライブラリ」
2. 「Gmail API」を検索 →「有効にする」

---

### 手順 2: OAuth2 クライアントIDを作成

1. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアントID」
2. **アプリケーションの種類**：「ウェブアプリケーション」
3. 名前を入力（例: `lumber-gmail`）
4. 「承認済みのリダイレクトURI」に追加：
   ```
   https://developers.google.com/oauthplayground
   ```
5. 「作成」→ **クライアントID** と **クライアントシークレット** をメモ

> ⚠️ 初回は「OAuth同意画面」の設定を求められます。
> 「外部」を選択 → アプリ名・メールアドレスを入力 → 「保存して次へ」を繰り返す。

---

### 手順 3: リフレッシュトークンを取得

1. [OAuth Playground](https://developers.google.com/oauthplayground/) にアクセス
2. 右上の設定アイコン ⚙️ をクリック
3. **「Use your own OAuth credentials」** をチェック
4. 手順2の **クライアントID** と **クライアントシークレット** を入力 →「Close」
5. 左の「Step 1」の入力欄に以下を入力してから「Authorize APIs」をクリック：
   ```
   https://mail.googleapis.com/
   ```
6. Googleアカウントでログイン → 権限を承認
7. 「Step 2」→「Exchange authorization code for tokens」をクリック
8. **Refresh token** をコピー

9. `.env` に設定：

```env
GMAIL_USER=your-gmail@gmail.com
GMAIL_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
GMAIL_REFRESH_TOKEN=1//xxxxxxxxxxxxxxxxxxxxxxxx
```

---

### Gmail で送信されるメール

| 機能 | 送信タイミング | 送信先 |
|---|---|---|
| 請求書PDF添付 | `請求書メール送付` コマンド | 顧客のメールアドレス |
| 発注確認 | 発注作成時 | 仕入先のメールアドレス |
| 在庫アラート | 出庫後に発注点以下になった時 | `GMAIL_USER`（管理者） |
| 月次レポート | 毎月1日 8:00 JST（自動）または `月次レポート送信` コマンド | `GMAIL_USER`（管理者） |

> 顧客・仕入先のメールアドレスは `customers.email` / `suppliers.email` 列に登録してください
>（現在は管理画面からの編集UIは未実装。SQLite DBに直接 UPDATE するか、admin API経由で設定します）。

---

## 管理画面

`http://localhost:3000` にアクセス

| タブ | 主な機能 |
|---|---|
| 🏠 ホーム | KPIカード・在庫アラート・承認待ち発注 |
| 📦 在庫 | 全品目一覧・在庫数・発注点表示 |
| 📋 発注 | 発注一覧・承認/却下操作 |
| 📄 見積書 | 見積書一覧・PDFダウンロード・ステータス変更 |
| 🚚 納品書 | 納品書一覧・PDFダウンロード |
| 💴 請求書 | 請求書番号・小計・消費税・支払期限付き一覧・PDF・入金済処理 |
| 👥 顧客・掛け率 | 掛け率のインライン編集 |
| 📐 材積計算 | 材積・才の計算ツール（よく使う規格プリセット付き） |
| 📋 棚卸し履歴 | 棚卸し調整履歴の一覧 |
| 📱 LINE送信 | テストメッセージ送信 |

---

## ディレクトリ構成

```
lumber-line-demo/
├── src/
│   ├── server.js                    # Express サーバー・起動処理・cron設定
│   ├── db/
│   │   ├── schema.sql               # テーブル定義
│   │   └── database.js              # DB接続・シードデータ
│   ├── handlers/
│   │   ├── messageHandler.js        # LINE テキスト/Postback ルーター
│   │   ├── inventoryHandler.js      # 在庫・入出庫
│   │   ├── orderHandler.js          # 発注
│   │   ├── invoiceHandler.js        # 請求書PDF・各種コマンド
│   │   ├── quoteHandler.js          # 見積書PDF・掛け率
│   │   ├── deliveryHandler.js       # 納品書PDF
│   │   ├── calcHandler.js           # 材積計算
│   │   ├── stockoutFlowHandler.js   # 出庫対話フロー
│   │   └── stocktakeHandler.js      # 棚卸し対話フロー
│   ├── integrations/
│   │   ├── sheetsSync.js            # Google Sheets 連携
│   │   └── gmailSend.js             # Gmail 送信連携
│   ├── line/
│   │   ├── flexMessages.js          # Flex Message ビルダー
│   │   └── richMenu.js              # リッチメニュー登録・PNG生成
│   ├── routes/
│   │   └── adminRoutes.js           # 管理REST API
│   └── sessions/
│       └── stocktakeSession.js      # インメモリセッション管理
├── public/
│   └── index.html                   # 管理画面SPA
├── fonts/
│   └── NotoSansJP-Regular.ttf       # 日本語フォント（PDFKit用）
├── invoices/                        # 生成された請求書PDF
├── pdfs/quotes/                     # 生成された見積書PDF
├── .env.example                     # 環境変数テンプレート
└── README.md
```

---

## GitHubへのアップロード

```bash
# 1. Gitリポジトリを初期化
git init

# 2. ファイルをステージング（.envは.gitignoreで除外済み）
git add .

# 3. 初回コミット
git commit -m "初期実装"

# 4. GitHubにリポジトリを作成してからリモートを登録
git remote add origin https://github.com/ユーザー名/lumber-line-demo.git

# 5. mainブランチにプッシュ
git branch -M main
git push -u origin main
```

> ⚠️ `.env` ファイルには LINE トークンや Google 認証情報が含まれています。  
> `.gitignore` で除外済みですが、`git add .` 前に `git status` で確認することを推奨します。

---

## Render へのデプロイ

`render.yaml` をそのまま使ってゼロコンフィグデプロイできます。

1. [Render](https://render.com/) にサインイン
2. 「**New +**」→「**Web Service**」→「**Connect a repository**」でGitHubリポジトリを選択
3. Render が `render.yaml` を自動検出してビルド設定を適用
4. 「**Environment**」タブで以下の環境変数を手動で設定：

| 変数名 | 値 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE チャンネルアクセストークン |
| `LINE_CHANNEL_SECRET` | LINE チャンネルシークレット |
| `ADMIN_LINE_USER_ID` | 管理者の LINE ユーザーID |
| `SERVER_URL` | Render の公開URL（例: `https://lumber-line-demo.onrender.com`） |
| `COMPANY_NAME` | 会社名 |
| その他 | Google/Gmail 連携を使う場合は各認証情報 |

5. 「**Deploy**」をクリック
6. デプロイ完了後、LINE Developers の Webhook URL を Render の URL に更新：
   ```
   https://lumber-line-demo.onrender.com/webhook
   ```

> ⚠️ Render 無料プランはアイドル時にスリープします。LINE Webhook のレスポンスが遅くなる場合があります。

---

## ライセンス

MIT
