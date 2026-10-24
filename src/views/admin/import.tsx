import { IMPORT_COLUMNS, type ImportRow, MAX_IMPORT_ROWS } from "../../lib/url-import";
import { type Flash, Layout } from "./layout";
import { formatJst } from "./time";

const COLUMN_DOCS: Record<
	(typeof IMPORT_COLUMNS)[number],
	{ required: boolean; description: (mainDomain: string) => string; example: string }
> = {
	url: {
		required: true,
		description: () => "転送先 URL（http / https）",
		example: "https://example.com/page",
	},
	slug: {
		required: false,
		description: () => "スラッグ。空欄ならランダムに生成します。",
		example: "spring-sale",
	},
	domain: {
		required: false,
		description: (main) => `短縮 URL のドメイン（登録済みのもの）。空欄なら ${main}。`,
		example: "",
	},
	expires_at: {
		required: false,
		description: () =>
			"有効期限（日本時間）。空欄なら期限なし。「2026-12-31 23:59」「2026/12/31 23:59」のほか、タイムゾーン付きの ISO 8601 も使えます。",
		example: "2026-12-31 23:59",
	},
	note: { required: false, description: () => "メモ（500 文字まで）", example: "春のキャンペーン" },
	folder: {
		required: false,
		description: () =>
			"フォルダ。階層は「/」で区切ります。空欄なら未分類。存在しないフォルダはエラーになります（自動では作りません）。",
		example: "キャンペーン / 2026",
	},
};

function FormError({ message }: { message?: string }) {
	return message ? (
		<p class="hint hint-err" role="alert">
			{message}
		</p>
	) : null;
}

function UploadForm({ error }: { error?: string }) {
	return (
		<form class="card" method="post" action="/admin/import" enctype="multipart/form-data">
			<h2>CSV から短縮 URL を一括作成</h2>
			<div class="row">
				<div class="field">
					<label for="file">CSV ファイル</label>
					<input id="file" name="file" type="file" accept=".csv,text/csv" required />
				</div>
				<button type="submit" class="btn btn-p">
					内容を確認
				</button>
				<a class="btn btn-s" href="/admin/import/template.csv">
					テンプレート CSV をダウンロード
				</a>
			</div>
			<FormError message={error} />
			<p class="hint">
				アップロードしただけでは登録されません。次の画面で内容を確認してから登録します。
			</p>
		</form>
	);
}

export function ImportPage(props: { mainDomain: string; flash?: Flash | null; error?: string }) {
	return (
		<Layout title="CSV インポート" section="import" flash={props.flash}>
			<UploadForm error={props.error} />
			<div class="card">
				<h2>CSV の形式</h2>
				<p class="hint" style="margin:0 0 12px">
					1 行目に列名（見出し）を書き、2 行目から 1 行に 1 件ずつ書きます。列の順番は自由で、url
					以外の列は省略できます。テンプレート CSV は見出し行だけの空の CSV です。
				</p>
				<div style="overflow-x:auto">
					<table class="tbl">
						<thead>
							<tr>
								<th>列名</th>
								<th>必須</th>
								<th>内容</th>
								<th>例</th>
							</tr>
						</thead>
						<tbody>
							{IMPORT_COLUMNS.map((col) => {
								const doc = COLUMN_DOCS[col];
								return (
									<tr key={col}>
										<td data-label="列名">
											<code>{col}</code>
										</td>
										<td data-label="必須" style="white-space:nowrap">
											{doc.required ? "必須" : "任意"}
										</td>
										<td data-label="内容">{doc.description(props.mainDomain)}</td>
										<td data-label="例">
											{(col === "domain" ? props.mainDomain : doc.example) || "—"}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				<ul class="notes">
					<li>
						文字コードは UTF-8 または Shift_JIS です。Excel の「CSV
						UTF-8（コンマ区切り）」「CSV（コンマ区切り）」のどちらで保存しても読み込めます。
					</li>
					<li>{`1 回に取り込めるのは ${MAX_IMPORT_ROWS} 行・1 MB までです。`}</li>
					<li>
						1 行でもエラーがあると、1
						件も登録しません。エラーの行を直してからアップロードし直してください。
					</li>
					<li>
						同じドメインに同じスラッグの URL がある場合（削除済みを含む）や、CSV
						の中でスラッグが重複している場合はエラーになります。既存の URL は変更しません。
					</li>
					<li>
						値にカンマ・改行・「"」を含む場合は「"」で囲んでください（Excel なら自動で囲みます）。
					</li>
				</ul>
			</div>
		</Layout>
	);
}

function PreviewTable({ rows }: { rows: ImportRow[] }) {
	return (
		<div class="card" style="padding:0;overflow-x:auto">
			<table class="tbl">
				<thead>
					<tr>
						<th>行</th>
						<th>短縮 URL</th>
						<th>転送先</th>
						<th>有効期限</th>
						<th>フォルダ</th>
						<th>メモ</th>
						<th>結果</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.line} class={r.errors.length > 0 ? "row-err" : undefined}>
							<td data-label="行">{r.line}</td>
							<td data-label="短縮 URL">
								<span class="tbl-url">{`${r.domain}/${r.values.slug || "（自動生成）"}`}</span>
								{r.generated && <span class="folder-path">（自動生成）</span>}
							</td>
							<td data-label="転送先">
								<span class="tbl-url">{r.values.url || "—"}</span>
							</td>
							<td data-label="有効期限">
								{r.expires_at ? formatJst(r.expires_at) : r.values.expires_at || "—"}
							</td>
							<td data-label="フォルダ">
								{r.values.folder ? <span class="folder-path">{r.values.folder}</span> : "—"}
							</td>
							<td data-label="メモ">{r.values.note || "—"}</td>
							<td data-label="結果">
								{r.errors.length === 0 ? (
									<span class="pill pill-active">OK</span>
								) : (
									<ul class="errs">
										{r.errors.map((e) => (
											<li key={e}>{e}</li>
										))}
									</ul>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/**
 * アップロードした CSV の確認画面。エラーが無ければ CSV の本文と自動生成したスラッグを hidden で
 * 持たせて登録へ進める（登録時にもう一度読み直して検証する）。エラーがあればエラーの行だけを表示する。
 */
export function ImportPreviewPage(props: {
	rows: ImportRow[];
	csv: string;
	/** 自動生成したスラッグ（generatedSlugsField） */
	slugs: string;
	error?: string;
}) {
	const { rows } = props;
	const invalid = rows.filter((r) => r.errors.length > 0);
	const flash: Flash | null = props.error ? { kind: "error", message: props.error } : null;
	return (
		<Layout title="CSV インポートの確認" section="import" flash={flash}>
			<p class="hint" style="margin:0 0 12px">
				<a href="/admin/import">← アップロードし直す</a>
			</p>
			{invalid.length === 0 ? (
				<>
					<form class="card" method="post" action="/admin/import/commit">
						<h2>内容の確認</h2>
						<p class="hint" style="margin:0">
							{`${rows.length} 件の短縮 URL を作成します。内容を確認して「登録」を押してください。`}
						</p>
						<input type="hidden" name="csv" value={props.csv} />
						<input type="hidden" name="slugs" value={props.slugs} />
						<div class="form-actions">
							<a class="btn btn-s" href="/admin/import">
								キャンセル
							</a>
							{!props.error && (
								<button type="submit" class="btn btn-p">
									{`${rows.length} 件を登録`}
								</button>
							)}
						</div>
					</form>
					<PreviewTable rows={rows} />
				</>
			) : (
				<>
					<div class="card">
						<h2>内容の確認</h2>
						<p class="hint hint-err" role="alert" style="margin:0">
							{`${rows.length} 行のうち ${invalid.length} 行にエラーがあるため、登録できません（1 件も登録していません）。CSV を直してアップロードし直してください。`}
						</p>
						{invalid.length < rows.length && (
							<p class="hint">{`エラーの無い ${rows.length - invalid.length} 行は表示を省いています。`}</p>
						)}
					</div>
					<PreviewTable rows={invalid} />
					<UploadForm />
				</>
			)}
		</Layout>
	);
}

/** 登録後の結果画面。作成した短縮 URL の一覧と、結果 CSV のダウンロード */
export function ImportResultPage({ rows }: { rows: ImportRow[] }) {
	const urls = rows.map((r) => `${r.domain}/${r.values.slug}`).join("\n");
	return (
		<Layout
			title="CSV インポートの結果"
			section="import"
			flash={{ kind: "ok", message: `CSV から ${rows.length} 件の短縮 URL を作成しました。` }}
		>
			<form class="card" method="post" action="/admin/import/result.csv">
				<h2>作成した短縮 URL</h2>
				<p class="hint" style="margin:0">
					作成した短縮 URL を CSV でダウンロードできます（自動生成したスラッグを含みます）。
				</p>
				<input type="hidden" name="urls" value={urls} />
				<div class="form-actions">
					<a class="btn btn-s" href="/admin/urls">
						一覧へ
					</a>
					<a class="btn btn-s" href="/admin/import">
						続けてインポート
					</a>
					<button type="submit" class="btn btn-p">
						結果を CSV でダウンロード
					</button>
				</div>
			</form>
			<div class="card" style="padding:0;overflow-x:auto">
				<table class="tbl">
					<thead>
						<tr>
							<th>行</th>
							<th>短縮 URL</th>
							<th>転送先</th>
							<th>有効期限</th>
							<th>フォルダ</th>
							<th>メモ</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => {
							const short = `${r.domain}/${r.values.slug}`;
							return (
								<tr key={short}>
									<td data-label="行">{r.line}</td>
									<td data-label="短縮 URL">
										<span class="tbl-url">{short}</span>{" "}
										<button type="button" class="copy-btn" data-copy={`https://${short}`}>
											コピー
										</button>
									</td>
									<td data-label="転送先">
										<span class="tbl-url">{r.values.url}</span>
									</td>
									<td data-label="有効期限">{r.expires_at ? formatJst(r.expires_at) : "—"}</td>
									<td data-label="フォルダ">
										{r.values.folder ? <span class="folder-path">{r.values.folder}</span> : "—"}
									</td>
									<td data-label="メモ">{r.values.note || "—"}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</Layout>
	);
}
