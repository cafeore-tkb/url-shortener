import type { DomainResponse } from "../../routes/api/domains";
import type { FolderResponse } from "../../routes/api/folders";
import type { UrlRow } from "../../types";
import { FolderOptions, folderLabel } from "./folders";
import { type Flash, Layout } from "./layout";
import { formatJst, parseStoredDate, toJstInputValue } from "./time";

export const URL_STATUS_FILTERS = ["active", "expired", "deleted", "all"] as const;
export type UrlStatusFilter = (typeof URL_STATUS_FILTERS)[number];

/** 一覧の絞り込み条件。編集・削除などの後も同じ条件の一覧に戻すため、各操作の URL に引き継ぐ */
export type UrlListQuery = {
	status: UrlStatusFilter;
	/** "all" で全ドメイン */
	domain: string;
	/** "" = フォルダで絞り込まない、"none" = 未分類、数字 = そのフォルダの直下 */
	folder: string;
	q: string;
	page: number;
};

export type Pagination = { page: number; per_page: number; total: number; total_pages: number };

export type UrlCreateValues = {
	url: string;
	slug: string;
	domain: string;
	expires_at: string;
	note: string;
	/** select の値（"" = 未分類） */
	folder_id: string;
};

export type UrlEditValues = {
	target_url: string;
	expires_at: string;
	note: string;
	folder_id: string;
};

const STATUS_LABELS: Record<UrlStatusFilter, string> = {
	active: "有効",
	expired: "期限切れ",
	deleted: "削除済み",
	all: "すべて",
};

/** 既定値と同じ条件は省いたクエリ文字列（先頭の ? 付き、条件が無ければ空文字） */
export function listQueryString(query: UrlListQuery): string {
	const params = new URLSearchParams();
	if (query.status !== "active") params.set("status", query.status);
	if (query.domain !== "all") params.set("domain", query.domain);
	if (query.folder) params.set("folder_id", query.folder);
	if (query.q) params.set("q", query.q);
	if (query.page > 1) params.set("page", String(query.page));
	const qs = params.toString();
	return qs ? `?${qs}` : "";
}

export function urlPath(row: Pick<UrlRow, "domain" | "slug">, suffix = ""): string {
	return `/admin/urls/${encodeURIComponent(row.domain)}/${encodeURIComponent(row.slug)}${suffix}`;
}

function rowState(row: UrlRow): "active" | "expired" | "deleted" {
	if (row.deleted_at) return "deleted";
	if (row.expires_at && parseStoredDate(row.expires_at) < Date.now()) return "expired";
	return "active";
}

function StatePill({ row }: { row: UrlRow }) {
	const state = rowState(row);
	return <span class={`pill pill-${state}`}>{STATUS_LABELS[state]}</span>;
}

function FormError({ message }: { message?: string }) {
	return message ? (
		<p class="hint hint-err" role="alert">
			{message}
		</p>
	) : null;
}

function FolderSelect({ folders, selected }: { folders: FolderResponse[]; selected: string }) {
	return (
		<select id="folder_id" name="folder_id">
			<option value="">（未分類）</option>
			<FolderOptions folders={folders} selected={selected} />
		</select>
	);
}

function CreateForm({
	domains,
	folders,
	query,
	defaultDomain,
	values,
	error,
}: {
	domains: DomainResponse[];
	folders: FolderResponse[];
	query: UrlListQuery;
	defaultDomain: string;
	values?: UrlCreateValues;
	error?: string;
}) {
	const selected = values?.domain || defaultDomain;
	// フォルダで絞り込んでいるときは、そのフォルダに作るのを既定にする
	const folder = values?.folder_id ?? (/^\d+$/.test(query.folder) ? query.folder : "");
	return (
		<form class="card" method="post" action={`/admin/urls${listQueryString(query)}`}>
			<h2>短縮 URL を作成</h2>
			<div class="row">
				<div class="field">
					<label for="url">転送先 URL</label>
					<input
						id="url"
						name="url"
						type="url"
						required
						placeholder="https://example.com/long-url"
						value={values?.url}
					/>
				</div>
				<div class="field">
					<label for="slug">スラッグ（任意）</label>
					<input id="slug" name="slug" placeholder="my-slug" value={values?.slug} />
				</div>
				<div class="field">
					<label for="domain">ドメイン</label>
					<select id="domain" name="domain">
						{domains.map((d) => (
							<option key={d.domain} value={d.domain} selected={d.domain === selected}>
								{`${d.name}（${d.domain}）`}
							</option>
						))}
					</select>
				</div>
				<div class="field">
					<label for="expires_at">有効期限（任意・日本時間）</label>
					<input
						id="expires_at"
						name="expires_at"
						type="datetime-local"
						value={values?.expires_at}
					/>
				</div>
				<div class="field">
					<label for="note">メモ（任意）</label>
					<input id="note" name="note" maxlength={500} value={values?.note} />
				</div>
				<div class="field">
					<label for="folder_id">フォルダ</label>
					<FolderSelect folders={folders} selected={folder} />
				</div>
				<button type="submit" class="btn btn-p">
					作成
				</button>
			</div>
			<FormError message={error} />
		</form>
	);
}

function FilterBar({
	domains,
	folders,
	query,
}: {
	domains: DomainResponse[];
	folders: FolderResponse[];
	query: UrlListQuery;
}) {
	return (
		<form class="filter-bar" method="get" action="/admin/urls">
			<input name="q" type="search" placeholder="スラッグ・URL・メモで検索" value={query.q} />
			<select name="status" aria-label="状態" data-autosubmit>
				{URL_STATUS_FILTERS.map((s) => (
					<option key={s} value={s} selected={s === query.status}>
						{STATUS_LABELS[s]}
					</option>
				))}
			</select>
			<select name="domain" aria-label="ドメイン" data-autosubmit>
				<option value="all" selected={query.domain === "all"}>
					すべてのドメイン
				</option>
				{domains.map((d) => (
					<option key={d.domain} value={d.domain} selected={d.domain === query.domain}>
						{d.name}
					</option>
				))}
			</select>
			<select name="folder_id" aria-label="フォルダ" data-autosubmit>
				<option value="" selected={query.folder === ""}>
					すべてのフォルダ
				</option>
				<option value="none" selected={query.folder === "none"}>
					未分類
				</option>
				<FolderOptions folders={folders} selected={query.folder} />
			</select>
			<button type="submit" class="btn btn-s">
				絞り込む
			</button>
		</form>
	);
}

function UrlTable({
	urls,
	folders,
	query,
}: {
	urls: UrlRow[];
	folders: FolderResponse[];
	query: UrlListQuery;
}) {
	const qs = listQueryString(query);
	return (
		<div class="card" style="padding:0;overflow-x:auto">
			<table class="tbl">
				<thead>
					<tr>
						<th>短縮 URL</th>
						<th>転送先</th>
						<th>状態</th>
						<th>クリック数</th>
						<th>有効期限</th>
						<th>フォルダ</th>
						<th>メモ</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{urls.map((u) => {
						const short = `${u.domain}/${u.slug}`;
						return (
							<tr key={short}>
								<td data-label="短縮 URL">
									<span class="tbl-url">{short}</span>{" "}
									<button type="button" class="copy-btn" data-copy={`https://${short}`}>
										コピー
									</button>
								</td>
								<td data-label="転送先">
									<a href={u.target_url} target="_blank" rel="noopener noreferrer" class="tbl-url">
										{u.target_url}
									</a>
								</td>
								<td data-label="状態">
									<StatePill row={u} />
								</td>
								<td data-label="クリック数">{u.clicks}</td>
								<td data-label="有効期限">{u.expires_at ? formatJst(u.expires_at) : "—"}</td>
								<td data-label="フォルダ">
									{u.folder_id !== null && folders.some((f) => f.id === u.folder_id) ? (
										<span class="folder-path">{folderLabel(folders, u.folder_id)}</span>
									) : (
										"—"
									)}
								</td>
								<td data-label="メモ">{u.note || "—"}</td>
								<td data-label="操作">
									<div class="actions">
										{u.deleted_at ? (
											<form method="post" action={urlPath(u, `/restore${qs}`)}>
												<button type="submit" class="btn btn-p btn-sm">
													復元
												</button>
											</form>
										) : (
											<>
												<a class="btn btn-s btn-sm" href={urlPath(u, qs)}>
													編集
												</a>
												<form
													method="post"
													action={urlPath(u, `/delete${qs}`)}
													data-confirm={`${short} を削除しますか？短縮 URL はリダイレクトしなくなります。`}
												>
													<button type="submit" class="btn btn-d btn-sm">
														削除
													</button>
												</form>
											</>
										)}
									</div>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function Pager({ query, pagination }: { query: UrlListQuery; pagination: Pagination }) {
	if (pagination.total_pages <= 1) return null;
	const page = pagination.page;
	return (
		<nav class="pager" aria-label="ページ送り">
			{page > 1 && (
				<a
					class="btn btn-s btn-sm"
					href={`/admin/urls${listQueryString({ ...query, page: page - 1 })}`}
				>
					前へ
				</a>
			)}
			<span>{`${page} / ${pagination.total_pages} ページ（全 ${pagination.total} 件）`}</span>
			{page < pagination.total_pages && (
				<a
					class="btn btn-s btn-sm"
					href={`/admin/urls${listQueryString({ ...query, page: page + 1 })}`}
				>
					次へ
				</a>
			)}
		</nav>
	);
}

export function UrlsPage(props: {
	domains: DomainResponse[];
	folders: FolderResponse[];
	defaultDomain: string;
	query: UrlListQuery;
	urls: UrlRow[];
	pagination: Pagination;
	flash?: Flash | null;
	values?: UrlCreateValues;
	error?: string;
}) {
	const { domains, folders, query, urls, pagination } = props;
	return (
		<Layout title="短縮 URL" section="urls" flash={props.flash}>
			<CreateForm
				domains={domains}
				folders={folders}
				query={query}
				defaultDomain={props.defaultDomain}
				values={props.values}
				error={props.error}
			/>
			<FilterBar domains={domains} folders={folders} query={query} />
			{urls.length === 0 ? (
				<div class="empty">該当する URL はありません</div>
			) : (
				<UrlTable urls={urls} folders={folders} query={query} />
			)}
			<Pager query={query} pagination={pagination} />
		</Layout>
	);
}

export function UrlEditPage(props: {
	row: UrlRow;
	folders: FolderResponse[];
	query: UrlListQuery;
	flash?: Flash | null;
	values?: UrlEditValues;
	error?: string;
}) {
	const { row, query } = props;
	const values = props.values ?? {
		target_url: row.target_url,
		expires_at: toJstInputValue(row.expires_at),
		note: row.note ?? "",
		folder_id: row.folder_id === null ? "" : String(row.folder_id),
	};
	const short = `https://${row.domain}/${row.slug}`;
	const back = `/admin/urls${listQueryString(query)}`;
	return (
		<Layout title={`編集: ${row.domain}/${row.slug}`} section="urls" flash={props.flash}>
			<p class="hint" style="margin:0 0 12px">
				<a href={back}>← 一覧に戻る</a>
			</p>
			<div class="card">
				<h2>{`短縮 URL を編集: ${row.domain}/${row.slug}`}</h2>
				<dl class="meta">
					<dt>短縮 URL</dt>
					<dd>
						{short}{" "}
						<button type="button" class="copy-btn" data-copy={short}>
							コピー
						</button>
					</dd>
					<dt>状態</dt>
					<dd>
						<StatePill row={row} />
					</dd>
					<dt>クリック数</dt>
					<dd>{row.clicks}</dd>
					<dt>作成日時</dt>
					<dd>{formatJst(row.created_at)}</dd>
				</dl>
				{row.deleted_at ? (
					<>
						<p class="hint">削除済みの URL は編集できません。復元してから編集してください。</p>
						<form method="post" action={urlPath(row, `/restore${listQueryString(query)}`)}>
							<div class="form-actions">
								<button type="submit" class="btn btn-p">
									復元
								</button>
							</div>
						</form>
					</>
				) : (
					<form class="stack" method="post" action={urlPath(row, listQueryString(query))}>
						<div class="field">
							<label for="target_url">転送先 URL</label>
							<input
								id="target_url"
								name="target_url"
								type="url"
								required
								value={values.target_url}
							/>
						</div>
						<div class="field">
							<label for="expires_at">有効期限（日本時間・空欄で期限なし）</label>
							<input
								id="expires_at"
								name="expires_at"
								type="datetime-local"
								value={values.expires_at}
							/>
						</div>
						<div class="field">
							<label for="note">メモ</label>
							<textarea id="note" name="note" maxlength={500}>
								{values.note}
							</textarea>
						</div>
						<div class="field">
							<label for="folder_id">フォルダ</label>
							<FolderSelect folders={props.folders} selected={values.folder_id} />
						</div>
						<FormError message={props.error} />
						<div class="form-actions">
							<a class="btn btn-s" href={back}>
								キャンセル
							</a>
							<button type="submit" class="btn btn-p">
								保存
							</button>
						</div>
					</form>
				)}
			</div>
		</Layout>
	);
}
