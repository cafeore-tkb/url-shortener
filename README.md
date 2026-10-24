# URL Shortener

Cloudflare Workers 上で動作するマルチドメイン対応の URL 短縮サービスです。D1、Hono、Cloudflare Access 認証を使用しています。

## 技術スタック

- **ランタイム**: Cloudflare Workers
- **フレームワーク**: [Hono](https://hono.dev/)（管理画面は hono/jsx でサーバー側レンダリング）
- **データベース**: Cloudflare D1 (SQLite)
- **認証**: Cloudflare Access (JWT)
- **テスト**: Vitest + `@cloudflare/vitest-pool-workers`
- **リンター**: Biome

## 前提条件

- Node.js >= 18
- npm
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- Cloudflare アカウント（デプロイ時に必要）

## 環境変数

`wrangler.jsonc` の `vars` セクションで設定します。

| 変数名 | 説明 | 例 |
|--------|------|-----|
| `TEAM_DOMAIN` | Cloudflare Access のチームドメイン | `your-team.cloudflareaccess.com` |
| `POLICY_AUD` | Cloudflare Access ポリシーの Audience タグ | `your-policy-aud-tag` |
| `MAIN_DOMAIN` | 管理画面 (`/admin`) にアクセス可能なメインドメイン | `s.example.com` |
| `DEV_AUTH_BYPASS` | `"true"` で認証をバイパス（ローカル開発用。`wrangler.jsonc` ではなく `.dev.vars` に書く。本番では設定しない） | `true` |
| `CF_SAAS_ZONE_ID` | （任意）Cloudflare for SaaS を有効にしたゾーンの Zone ID | `0123...cdef` |
| `CF_SAAS_CNAME_TARGET` | （任意）外部アカウント側が CNAME を向ける先。fallback origin を直接指定してもよい | `service.example.net` |

シークレット（`wrangler secret put` で設定、`vars` には書かない）:

| 変数名 | 説明 |
|--------|------|
| `CF_SAAS_API_TOKEN` | （任意）Custom Hostnames API 用トークン。権限は **Zone / SSL and Certificates / Edit** |

`CF_SAAS_ZONE_ID` と `CF_SAAS_API_TOKEN` のどちらかが未設定の場合、Cloudflare for SaaS 連携は無効になり Cloudflare API は一切呼ばれません（従来どおりの動作）。

また、`d1_databases[0].database_id` にはデプロイ先の D1 データベース ID を設定してください。

## ローカル開発

```bash
npm install
cp .dev.vars.example .dev.vars   # DEV_AUTH_BYPASS=true（ローカルで認証をバイパス）
npm run db:migrate:local
npm run db:seed:local    # localhost ドメインを D1 に挿入
npm run dev
# http://localhost:8787/admin で管理画面にアクセス
```

リポジトリの `wrangler.jsonc` はローカル開発用の値（`MAIN_DOMAIN: "localhost"` とプレースホルダ）になっています。デプロイ時は [初回セットアップ](#初回セットアップ) に従って自分の環境の値に変更してください。`DEV_AUTH_BYPASS` は誤って本番にデプロイしないよう `wrangler.jsonc` には書かず、`.dev.vars`（git 管理外）で設定します。

## テスト

```bash
npm test            # 全テスト実行
npm run test:watch  # ウォッチモード
npm run typecheck   # 型チェック
npm run lint        # Biome リント
```

## デプロイ

### 初回セットアップ

1. D1 データベースを作成する:

```bash
npx wrangler d1 create url-shortener-db
```

出力に表示される `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id` に設定してください。

2. `wrangler.jsonc` の `vars` セクションで `TEAM_DOMAIN`、`POLICY_AUD`、`MAIN_DOMAIN` を本番の値に更新する。

3. マイグレーションを適用してデプロイする:

```bash
npm run db:migrate:remote   # 本番 D1 にマイグレーション適用
npm run deploy              # Cloudflare Workers にデプロイ
```

4. 初期ドメインをリモート D1 に登録する:

`MAIN_DOMAIN` は管理画面のアクセス制御に使われるだけで、ドメインミドルウェアは D1 の `domains` テーブルを参照します。テーブルにドメインが未登録だと `Unknown domain` エラーになるため、初回デプロイ後に登録が必要です。

```bash
npx wrangler d1 execute url-shortener-db --remote \
  --command="INSERT OR IGNORE INTO domains (domain, name) VALUES ('your-domain.com', 'Main');"
```

### 2 回目以降のデプロイ

デプロイは手元から次のコマンドで行います（GitHub Actions による自動デプロイはありません）。

```bash
npm run db:migrate:remote   # 新しいマイグレーションがあれば適用
npm run deploy
```

**注意:** `wrangler deploy` は `wrangler.jsonc` の `vars` でダッシュボード上の環境変数を上書きします。`vars` の値はダッシュボードではなく `wrangler.jsonc` で管理してください。

Worker の実行時に使う `CF_SAAS_API_TOKEN` は、`npx wrangler secret put CF_SAAS_API_TOKEN` で Worker の secret に投入してください。

なお、Pull Request と `main` への push では `.github/workflows/ci.yml` が typecheck / lint / test を実行します（デプロイは行いません）。

## 新しいドメインの追加（同じアカウント内）

1. ドメインの DNS レコードを Worker に向ける
2. Cloudflare ダッシュボードでドメインルートを追加する
3. API でドメインを作成する:

```bash
curl -X POST https://MAIN_DOMAIN/api/domains \
  -H "Content-Type: application/json" \
  -H "Cf-Access-Jwt-Assertion: <token>" \
  -d '{"domain":"new.example.com","name":"My Domain"}'
```

## 別 Cloudflare アカウントのドメインを追加する（Cloudflare for SaaS）

DNS ゾーンが**別の Cloudflare アカウント**にある、あるいは **Cloudflare を使っていない**ドメインを短縮ドメインにしたい場合は、[Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/)（カスタムホスト名）を使います。相手側の作業は DNS レコードの追加だけで済み、Worker と D1 は 1 セットのまま運用できます。

### 1. Cloudflare 側の初期セットアップ（1 回だけ・手動）

1. SaaS ゾーン（例: `example.net`）で **Cloudflare for SaaS** を有効化する
   （ダッシュボード → SSL/TLS → Custom Hostnames）
2. **fallback origin** を作る — オリジンを持たない proxied な AAAA レコードを作り、それを Fallback Origin に指定する:

   | Type | Name | Value | Proxy |
   |------|------|-------|-------|
   | AAAA | `service.example.net` | `100::` | Proxied |

3. **CNAME target**（任意）を作る — 相手に伝える値。作らない場合は fallback origin（`service.example.net`）をそのまま相手に伝える:

   | Type | Name | Value | Proxy |
   |------|------|-------|-------|
   | CNAME | `customers.example.net` | `service.example.net` | Proxied |

4. **Worker route** を張る — カスタムホスト名のトラフィックは SaaS ゾーンを通るので、ゾーン全体にワイルドカード route を張ります。`wrangler.jsonc` に追記してデプロイ:

   ```jsonc
   "routes": [
     { "pattern": "*/*", "zone_name": "example.net" }
   ]
   ```

   **`custom_domain: true` は使えません。** Custom Domain は Cloudflare が DNS レコードを自前で作る仕組みで、fallback origin 用の originless レコードと共存できないためです。

5. **API トークン**を作る — 権限 **Zone / SSL and Certificates / Edit**（対象は SaaS ゾーン）

6. Worker に設定を入れる。`wrangler.jsonc` の `vars` に `CF_SAAS_ZONE_ID` / `CF_SAAS_CNAME_TARGET` を書いてコミットし、トークンは secret として投入する:

   ```bash
   npx wrangler secret put CF_SAAS_API_TOKEN
   npm run deploy
   ```

### 2. ドメインを追加する

管理画面の「ドメインを追加」で **外部ドメイン（別アカウント）** にチェックを入れるか、API で `external: true` を渡します:

```bash
curl -X POST https://MAIN_DOMAIN/api/domains \
  -H "Content-Type: application/json" \
  -H "Cf-Access-Jwt-Assertion: <token>" \
  -d '{"domain":"go.other.com","name":"Partner","external":true}'
```

レスポンスの `dns_instructions.records`（管理画面にも表示されます）を相手アカウントの管理者に渡します。

**既に登録済みのドメインを external に切り替える**場合は、管理画面の **編集** で **外部ドメイン** にチェックを入れて保存するか、API で `PATCH` します。URL を残したまま切り替えられます（削除して作り直す必要はありません）:

```bash
curl -X PATCH https://MAIN_DOMAIN/api/domains/go.other.com \
  -H "Content-Type: application/json" \
  -H "Cf-Access-Jwt-Assertion: <token>" \
  -d '{"external":true}'
```

`{"external":false}` で元に戻すと Cloudflare 側のカスタムホスト名は削除されます。Cloudflare 側の登録 / 削除に失敗した場合は 502 を返し、D1 は変更しません。

> **注意:** 切り替え前にそのドメインが同じアカウントで Workers の Custom Domain として設定されている場合、Custom Domain の DNS レコードと相手側の CNAME は共存できません。ゾーンを別アカウントへ移す（または Custom Domain を外す）タイミングに合わせて切り替えてください。

### 3. 相手アカウント側の作業

| Type | Name | Value | 用途 |
|------|------|-------|------|
| CNAME | `go.other.com` | `customers.example.net` | トラフィックのルーティング |
| TXT | `_cf-custom-hostname.go.other.com` | API が返す UUID | ホスト名の所有権確認 |
| TXT | `_acme-challenge.go.other.com` | API が返す値 | 証明書の DCV |

証明書の DCV は **TXT の代わりに Delegated DCV（CNAME 1 本）** でも通せます。管理画面には両方が表示されるので、相手に **どちらか一方** を選んでもらってください（後述）。

- 相手ゾーンが Cloudflare なら、CNAME は **Proxied（オレンジ雲＝ orange-to-orange）でも DNS only でも** 有効化されます。
- TXT 2 種は用途もトークンも別です（所有権確認 / 証明書 DCV）。所有権確認が済んだら TXT は削除して構いません。
- **apex ドメイン**（`other.com` そのもの）は CNAME を張れません。相手ゾーンが Cloudflare なら CNAME flattening で対応できますが、そうでなければ Apex Proxying（Enterprise）が必要です。
- 相手ゾーンが Enterprise で **Zone Hold** を有効にしていると有効化がブロックされるため、一時解除が必要です。

### 3.5. Delegated DCV（証明書 DCV の自動化・任意）

`_acme-challenge` の **TXT レコードの代わりに CNAME を 1 本** 張ってもらう方式です。以降の証明書更新のたびに Cloudflare が委任先へ DCV トークンを配置するため、**相手側の作業は初回の 1 回だけ**で済みます。

| Type | Name | Value |
|------|------|-------|
| CNAME | `_acme-challenge.go.other.com` | `go.other.com.<uuid>.dcv.cloudflare.com` |

`<uuid>` は **SaaS ゾーンごとに固定**の値で、Worker が Cloudflare API から取得して管理画面と `dns_instructions.dcv_delegation_records` に表示します（`GET /zones/{zone_id}/dcv_delegation/uuid`、またはカスタムホスト名レスポンスの `ssl.dcv_delegation_records`）。

- **TXT と CNAME は同じ名前に共存できません。** どちらか一方だけを作ってもらってください。TXT 方式から切り替える場合は、先に `_acme-challenge` の TXT を削除する必要があります。
- **CNAME は消さないでください。** 更新のたびに Cloudflare がこの委任先へトークンを置くため、削除すると証明書の自動更新が止まります（TXT 方式は更新のたびに手作業が必要な代わりに、記録を消しても構いません）。
- DCV の委任先は 1 つのプロバイダーにしか向けられません。同じホスト名で他社の証明書も発行している場合は TXT 方式のままにしてください。
- UUID の取得に失敗した場合（トークンの権限不足など）、管理画面には CNAME が表示されず **従来どおり TXT 方式の案内だけ**になります。ドメインの登録自体は成功します。

出典: <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/delegated-dcv/>

### 4. ステータスを確認する

管理画面の **状態を更新** ボタン、または:

```bash
curl https://MAIN_DOMAIN/api/domains/go.other.com/hostname \
  -H "Cf-Access-Jwt-Assertion: <token>"
```

`hostname_status` と `ssl_status` が **両方 `active`** になれば本番トラフィックを流せます。

### 料金

カスタムホスト名は **全プランで 100 個まで無料**、それ以降は **1 ホスト名あたり月 $0.10** です（上限 50,000）。
出典: <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/>

## 管理画面

`MAIN_DOMAIN` の `/admin` で配信します（Cloudflare Access で保護）。画面は Hono のルートごとにサーバー側でレンダリングし、作成・更新・削除は通常のフォーム送信（POST → 303 リダイレクト）で行います。UI は日本語です。

| メソッド | パス | 画面 / 操作 |
|---------|------|------------|
| GET | `/admin` | `/admin/urls` へリダイレクト |
| GET | `/admin/urls` | 短縮 URL の一覧と作成フォーム（`status`, `domain`, `folder_id`, `q`, `page` で絞り込み） |
| POST | `/admin/urls` | 短縮 URL を作成 |
| GET | `/admin/urls/:domain/:slug` | 短縮 URL の編集画面 |
| POST | `/admin/urls/:domain/:slug` | 短縮 URL を更新 |
| POST | `/admin/urls/:domain/:slug/delete` | 短縮 URL を論理削除 |
| POST | `/admin/urls/:domain/:slug/restore` | 論理削除した短縮 URL を復元 |
| GET | `/admin/folders` | フォルダの一覧（階層表示）と作成フォーム |
| POST | `/admin/folders` | フォルダを作成 |
| GET | `/admin/folders/:id` | フォルダの編集画面（名前の変更・移動） |
| POST | `/admin/folders/:id` | フォルダを更新 |
| POST | `/admin/folders/:id/delete` | フォルダをサブフォルダごと削除（中の URL は未分類に戻る） |
| GET | `/admin/domains` | ドメインの一覧と追加フォーム |
| POST | `/admin/domains` | ドメインを追加 |
| GET | `/admin/domains/:domain` | ドメインの編集画面（410 ページのプレビュー付き） |
| POST | `/admin/domains/:domain` | ドメインを更新 |
| POST | `/admin/domains/:domain/refresh` | 外部ドメインのカスタムホスト名ステータスを再取得 |
| POST | `/admin/domains/:domain/delete` | ドメインを削除 |
| GET | `/admin/import` | CSV インポート（短縮 URL の一括作成）のアップロード画面 |
| GET | `/admin/import/template.csv` | テンプレート CSV（見出し行だけの空の CSV）をダウンロード |
| POST | `/admin/import` | CSV をアップロードして確認画面を表示（この時点では登録しない） |
| POST | `/admin/import/commit` | 確認画面の内容を登録して結果画面を表示 |
| POST | `/admin/import/result.csv` | 登録した短縮 URL を結果 CSV としてダウンロード |

- データの読み書きは `/api/*` と同じハンドラーを内部から呼んで行うため、バリデーションと挙動は REST API と同じです。API が返すエラーメッセージ（英語）はそのまま表示します。ただし CSV インポートだけは例外です（下記）。
- URL の操作後は、操作前の一覧の絞り込み条件（`status` / `domain` / `folder_id` / `q` / `page`）に戻ります。
- 有効期限などの日時は **日本時間（UTC+9）** で表示・入力します（D1 には UTC で保存）。
- 別オリジンからのフォーム送信は `hono/csrf`（`Origin` / `Sec-Fetch-Site` の検証）で拒否します。
- 他サイトの iframe への埋め込みは `X-Frame-Options: DENY` と CSP の `frame-ancestors 'none'` で禁止しています（クリックジャッキング対策）。
- JavaScript は確認ダイアログ・クリップボードへのコピー・絞り込みの自動送信・410 ページのライブプレビューにだけ使っており、無効でもコピー以外の操作はできます。

### CSV インポート

「CSV インポート」画面で、CSV から短縮 URL をまとめて作成できます。アップロード → 確認画面 → 登録 → 結果画面の順に進み、確認画面で「登録」を押すまでは何も登録しません。

1 行目に列名（見出し）を書き、2 行目から 1 行に 1 件ずつ書きます。列の順番は自由で、`url` 以外の列は省略できます。

| 列名 | 必須 | 内容 |
|------|------|------|
| `url` | 必須 | 転送先 URL（http / https） |
| `slug` | 任意 | スラッグ。空欄ならランダムに生成します（生成したスラッグは確認画面に表示します） |
| `domain` | 任意 | 短縮 URL のドメイン（登録済みのもの）。空欄なら `MAIN_DOMAIN` |
| `expires_at` | 任意 | 有効期限。`2026-12-31 23:59` や Excel が書き出す `2026/12/31 23:59` は日本時間、`2026-12-31T14:59:00Z` のようにタイムゾーンがあればそれに従います。日付だけは不可。空欄なら期限なし |
| `note` | 任意 | メモ（500 文字まで） |
| `folder` | 任意 | フォルダのパス（`親 / 子`）。空欄なら未分類。存在しないフォルダはエラー（自動では作りません） |

- 文字コードは UTF-8（BOM 付き可）または Shift_JIS。Excel の「CSV UTF-8（コンマ区切り）」「CSV（コンマ区切り）」のどちらでも読み込めます。
- 1 回に取り込めるのは 500 行・1 MB まで。
- **1 行でもエラーがあると 1 件も登録しません**。エラーの行と理由を一覧で表示します。
- 同じドメインに同じスラッグの URL がある場合（削除済みを含む）や、CSV の中でスラッグが重複している場合はエラーです。既存の URL は変更しません。
- 登録時に検証し直すため、確認画面を出してから登録するまでの間に同じスラッグの URL が作られた場合もエラーになり、何も登録しません。登録を再送信しても二重には登録されません。
- テンプレート CSV（見出し行だけ）と、登録した短縮 URL の結果 CSV（`short_url, url, slug, domain, expires_at, note, folder`）をダウンロードできます。どちらも Excel で文字化けしないよう BOM 付きの UTF-8 です。結果 CSV の日時は日本時間、フォルダはパスで書き出します。

CSV インポートは、ほかの画面と違って `/api/*` を経由せず D1 を直接読み書きします（`src/lib/url-import.ts`）。`/api/shorten` を行数分呼ぶと 1 回の Worker 実行で発行できる D1 のクエリ数の上限（[Free: 50 / Paid: 1,000](https://developers.cloudflare.com/d1/platform/limits/)）にすぐ届くうえ、途中で失敗すると一部だけ登録された状態が残るためです。検証には `/api/shorten` と同じ関数を使い、登録は `db.batch()`（上限に対して 1 クエリと数えられ、1 つでも失敗すると全体がロールバックされる）で 1 回にまとめています。そのため REST API・Service Binding に一括作成のエンドポイントはありません。

## API エンドポイント

`/api/*` 配下のルートはすべて、`Cf-Access-Jwt-Assertion` ヘッダーに有効な Cloudflare Access JWT が必要です。

CSRF 対策として、GET / HEAD / OPTIONS 以外のリクエストで、ブラウザが別オリジンからの送信だと示したもの（`Sec-Fetch-Site` が `same-origin` 以外、または `Origin` がリクエスト先と異なる）は 403 を返します。Access の Cookie（`CF_Authorization`）の SameSite は既定で None なので、JWT の検証だけでは罠ページからのフォーム送信を防げないためです。curl やサーバー間の呼び出しのように、どちらのヘッダーも付けないクライアントには影響しません。

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/health` | ヘルスチェック |
| GET | `/:slug` | 対象 URL へリダイレクト (302)、または 410/404 |
| GET | `/admin` | 管理画面（`/admin/urls` へリダイレクト、MAIN_DOMAIN のみ） |
| GET / POST | `/admin/urls`, `/admin/folders`, `/admin/domains` ほか | 管理画面の各ページとフォーム送信先（下記「管理画面」参照） |
| POST | `/api/shorten` | 短縮 URL を作成 |
| GET | `/api/urls` | URL 一覧取得 (`status`, `q`, `domain`, `folder_id`, `page`, `per_page` 対応) |
| GET | `/api/urls/:slug/stats` | URL の統計情報を取得 |
| PATCH | `/api/urls/:slug` | URL を更新 |
| DELETE | `/api/urls/:slug` | URL を論理削除 |
| POST | `/api/urls/:slug/restore` | 論理削除した URL を復元 |
| GET | `/api/domains` | 全ドメイン一覧取得 |
| POST | `/api/domains` | ドメインを作成 |
| PATCH | `/api/domains/:domain` | ドメインを更新 |
| GET | `/api/domains/:domain/hostname` | 外部ドメインのカスタムホスト名ステータスを Cloudflare から再取得して更新 |
| DELETE | `/api/domains/:domain` | ドメインを削除（URL が存在する場合は失敗、カスタムホスト名も削除） |
| GET | `/api/folders` | フォルダ一覧取得 |
| POST | `/api/folders` | フォルダを作成（`name`, `parent_id?`） |
| GET | `/api/folders/:id` | フォルダを取得 |
| PATCH | `/api/folders/:id` | フォルダ名の変更・移動（`name?`, `parent_id?`） |
| DELETE | `/api/folders/:id` | フォルダをサブフォルダごと削除（中の URL は未分類に戻る） |

### フォルダ

URL はフォルダで整理できます。フォルダはドメインに依存せず（1 つのフォルダに複数ドメインの URL を入れられる）、入れ子にできます。URL は 0〜1 個のフォルダに属し、`POST /api/shorten` / `PATCH /api/urls/:slug` の `folder_id`（`null` で未分類）で指定します。`GET /api/urls?folder_id=<id>` はそのフォルダ直下の URL だけを返し（サブフォルダ内は含まない）、`folder_id=none` で未分類の URL を返します。

## Service Binding（他の Worker から呼ぶ）

同じ Cloudflare アカウントの Worker からは、名前付きエントリポイント `ShortenerService` に [Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) を張ると、上記の `/api/*` と互換の操作を **Cloudflare Access の JWT なしで**呼べます。RPC と HTTP（`fetch`）のどちらでも使え、どちらも REST API と同じハンドラーを通るため、バリデーション・ステータスコード・レスポンスの形は REST API と同じです。

呼び出し側の `wrangler.jsonc`:

```jsonc
"services": [
  { "binding": "SHORTENER", "service": "url-shortener", "entrypoint": "ShortenerService" }
]
```

**`entrypoint` は必ず指定してください。** 省略すると default export（公開用のアプリ）に繋がり、`/api/*` は従来どおり Access の JWT を要求して 401 を返します。

### RPC

```ts
const result = await env.SHORTENER.shorten({ url: "https://example.com", slug: "hello" });
if (result.ok) {
  console.log(result.data.short_url); // https://<MAIN_DOMAIN>/hello
} else {
  console.error(result.status, result.error); // 例: 409 "Slug already exists"
}
```

戻り値はすべて `ServiceResult<T>` です（`{ ok: true, status, data }` または `{ ok: false, status, error }`）。`status` は REST API の HTTP ステータス、`data` は REST API のレスポンスボディ（204 の場合は `null`）、`error` は REST API の `error` と同じ文字列です。失敗は例外ではなく値で返します（RPC の例外は compatibility date によって `status` などの独自プロパティが落ちるため）。

| メソッド | 対応する REST API |
|---------|------------------|
| `shorten({ url, slug?, expires_at?, note?, domain?, folder_id? })` | `POST /api/shorten` |
| `listUrls({ domain?, status?, q?, folder_id?, page?, per_page? })` | `GET /api/urls` |
| `getUrlStats(slug, { domain? })` | `GET /api/urls/:slug/stats` |
| `updateUrl(slug, { target_url?, expires_at?, note?, folder_id? }, { domain? })` | `PATCH /api/urls/:slug` |
| `deleteUrl(slug, { domain? })` | `DELETE /api/urls/:slug` |
| `restoreUrl(slug, { domain? })` | `POST /api/urls/:slug/restore` |
| `listDomains()` | `GET /api/domains` |
| `createDomain({ domain, name, gone_*?, external? })` | `POST /api/domains` |
| `updateDomain(domain, { name?, gone_*?, external? })` | `PATCH /api/domains/:domain` |
| `refreshDomainHostname(domain)` | `GET /api/domains/:domain/hostname` |
| `deleteDomain(domain)` | `DELETE /api/domains/:domain` |
| `listFolders()` | `GET /api/folders` |
| `getFolder(id)` | `GET /api/folders/:id` |
| `createFolder({ name, parent_id? })` | `POST /api/folders` |
| `updateFolder(id, { name?, parent_id? })` | `PATCH /api/folders/:id` |
| `deleteFolder(id)` | `DELETE /api/folders/:id` |

URL 系メソッドの `domain` を省略すると `MAIN_DOMAIN` が対象になります（REST API で Host ヘッダーが `MAIN_DOMAIN` の場合と同じ）。`listUrls` は `domain: "all"` で全ドメインを返します。RPC は Host として `MAIN_DOMAIN` を使うため、`MAIN_DOMAIN` が `domains` テーブルに登録されている必要があります。

型は `src/service-binding.ts` に定義しています（`ShortenerService`, `ServiceResult`, `ShortenInput` など）。呼び出し側では `Service<ShortenerService>` として型付けできます。

### HTTP（fetch）

REST API と同じパス・ボディで呼べます。対象ドメインは URL のホスト（`Host` ヘッダーを付ければそちらが優先）で決まります。

```ts
const res = await env.SHORTENER.fetch("https://s.example.com/api/shorten", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com" }),
});
```

`fetch` で公開しているのは `/api/*` だけで、`/admin` とリダイレクト（`/:slug`）は 404 を返します。

### 認可について

- 名前付きエントリポイントはインターネットから到達できず、**同じアカウントで binding を宣言した Worker からしか呼べません**。この Worker は binding の宣言そのものを認可として扱い、Access の検証を行いません。
- binding を張った Worker は、ドメインの削除や Cloudflare for SaaS のカスタムホスト名の登録 / 削除を含む **API の全操作**ができます。binding を張る Worker は信頼できるものに限ってください。
- 呼び出し元の Access の認証情報は引き継がれません（[Cloudflare のドキュメント](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)）。ユーザー単位の認可が必要な場合は、呼び出し側の Worker で行ってください。

## プロジェクト構成

```
.
├── src/
│   ├── index.ts              # アプリのエントリポイント、ミドルウェア・ルート設定
│   ├── service-binding.ts    # Service Binding 用エントリポイント（ShortenerService）
│   ├── internal-api.ts       # /api/* のハンドラーを内部から呼ぶヘルパー（Service Binding・管理画面で共用）
│   ├── types.ts              # Bindings, DomainRow, UrlRow, FolderRow, AppEnv 型定義
│   ├── lib/
│   │   ├── cloudflare-saas.ts # Cloudflare for SaaS (Custom Hostnames) API クライアント
│   │   ├── csv.ts            # CSV の読み書き（RFC 4180）と文字コード判定（UTF-8 / Shift_JIS）
│   │   ├── domain-cache.ts   # ドメイン設定のインメモリキャッシュ（TTL: 60秒）
│   │   ├── errors.ts         # エラーレスポンスヘルパー
│   │   ├── folders.ts        # フォルダのサブツリー取得（再帰 CTE）などのヘルパー
│   │   ├── gone-page.ts      # 410 HTML レンダラー
│   │   ├── slug-generator.ts # ランダムスラグ生成
│   │   ├── url-import.ts     # 管理画面の CSV インポート（検証・一括登録・結果 CSV）
│   │   └── validation.ts     # 入力バリデーションヘルパー
│   ├── middleware/
│   │   ├── auth.ts           # Cloudflare Access JWT 検証
│   │   ├── csrf.ts           # /api/* の CSRF 対策（Origin / Sec-Fetch-Site の検証）
│   │   └── domain.ts         # Host ヘッダーによるドメイン検索
│   └── routes/
│       ├── admin.tsx         # 管理画面のルート（/admin/urls, /admin/folders, /admin/domains, /admin/import など）
│       ├── redirect.ts       # GET /:slug リダイレクトハンドラー
│       └── api/
│           ├── domains.ts    # ドメイン CRUD
│           ├── folders.ts    # フォルダ CRUD
│           └── urls.ts       # URL CRUD + 短縮
│   └── views/admin/          # 管理画面のビュー（hono/jsx でサーバー側レンダリング）
│       ├── layout.tsx        # 共通レイアウト・CSS・補助スクリプト
│       ├── urls.tsx          # 短縮 URL の一覧・作成・編集
│       ├── folders.tsx       # フォルダの一覧・作成・編集（木構造の組み立て）
│       ├── domains.tsx       # ドメインの一覧・追加・編集
│       └── time.ts           # 日本時間での日時の表示・入力変換
├── migrations/
│   ├── 0001_init.sql         # D1 スキーマ
│   ├── 0002_saas_custom_hostnames.sql # カスタムホスト名用カラム
│   ├── 0003_dcv_delegation.sql # Delegated DCV 用カラム
│   └── 0004_folders.sql      # フォルダ（folders テーブル・urls.folder_id）
├── test/
│   ├── fixtures/
│   │   └── seed.ts           # テストデータヘルパー
│   ├── integration/
│   │   ├── folders.test.ts   # フォルダ API の統合テスト
│   │   ├── full-flow.test.ts # E2E 統合テスト
│   │   ├── multi-domain.test.ts
│   │   └── service-binding.test.ts # Service Binding（RPC / fetch）の統合テスト
│   ├── lib/                  # ユニットテスト
│   ├── middleware/            # ミドルウェアテスト
│   ├── routes/               # ルートハンドラーテスト
│   └── views/                # ビューのヘルパーのテスト
├── wrangler.jsonc            # ローカル開発用の値。デプロイ時に自分の環境の値に変更する
├── .dev.vars.example         # ローカル開発用の環境変数（.dev.vars にコピーして使う）
├── vitest.config.ts
└── tsconfig.json
```
