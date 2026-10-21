import type { FolderResponse } from "../../routes/api/folders";
import { type Flash, Layout } from "./layout";

/** フォームの値。parent_id は select の値（"" = トップレベル） */
export type FolderValues = { name: string; parent_id: string };

type TreeItem = { folder: FolderResponse; depth: number };

export function folderPath(id: number, suffix = ""): string {
	return `/admin/folders/${id}${suffix}`;
}

/** API はフラットな一覧を返すので、親子関係から深さ優先の並び（兄弟は名前順）を組み立てる */
export function folderTree(folders: FolderResponse[]): TreeItem[] {
	const out: TreeItem[] = [];
	const walk = (parentId: number | null, depth: number) => {
		const children = folders
			.filter((f) => f.parent_id === parentId)
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const folder of children) {
			out.push({ folder, depth });
			walk(folder.id, depth + 1);
		}
	};
	walk(null, 0);
	return out;
}

/** "親 / 子 / 孫" 形式のフォルダ名 */
export function folderLabel(folders: FolderResponse[], id: number): string {
	const names: string[] = [];
	// parent_id が循環していても止まるよう、たどったフォルダを覚えておく
	const seen = new Set<number>();
	let current = folders.find((f) => f.id === id);
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		names.unshift(current.name);
		const parentId: number | null = current.parent_id;
		current = parentId === null ? undefined : folders.find((f) => f.id === parentId);
	}
	return names.join(" / ");
}

/** 自分自身と子孫すべての ID */
export function descendantIds(folders: FolderResponse[], id: number): number[] {
	const ids = [id];
	for (let i = 0; i < ids.length; i++) {
		for (const f of folders) {
			// 追加済みの ID を除くのは、parent_id が循環していても止まるようにするため
			if (f.parent_id === ids[i] && !ids.includes(f.id)) ids.push(f.id);
		}
	}
	return ids;
}

/** フォルダの <option> 群。階層は先頭の空白で表す */
export function FolderOptions({
	folders,
	selected,
	exclude = [],
}: {
	folders: FolderResponse[];
	selected: string;
	exclude?: number[];
}) {
	return (
		<>
			{folderTree(folders)
				.filter((t) => !exclude.includes(t.folder.id))
				.map((t) => (
					<option
						key={t.folder.id}
						value={String(t.folder.id)}
						selected={String(t.folder.id) === selected}
					>
						{`${"  ".repeat(t.depth)}${t.folder.name}`}
					</option>
				))}
		</>
	);
}

function FormError({ message }: { message?: string }) {
	return message ? (
		<p class="hint hint-err" role="alert">
			{message}
		</p>
	) : null;
}

export function FoldersPage(props: {
	folders: FolderResponse[];
	flash?: Flash | null;
	values?: FolderValues;
	error?: string;
}) {
	const { folders, values } = props;
	const tree = folderTree(folders);
	return (
		<Layout title="フォルダ" section="folders" flash={props.flash}>
			<form class="card" method="post" action="/admin/folders">
				<h2>フォルダを作成</h2>
				<div class="row">
					<div class="field">
						<label for="name">名前</label>
						<input
							id="name"
							name="name"
							required
							maxlength={100}
							placeholder="キャンペーン"
							value={values?.name}
						/>
					</div>
					<div class="field">
						<label for="parent_id">親フォルダ</label>
						<select id="parent_id" name="parent_id">
							<option value="">（トップレベル）</option>
							<FolderOptions folders={folders} selected={values?.parent_id ?? ""} />
						</select>
					</div>
					<button type="submit" class="btn btn-p">
						作成
					</button>
				</div>
				<FormError message={props.error} />
				<p class="hint">
					フォルダはすべてのドメインで共通で、入れ子にできます。フォルダを削除するとサブフォルダも削除されます。中の
					URL は削除されず、未分類に戻ります。
				</p>
			</form>

			{tree.length === 0 ? (
				<div class="empty">フォルダはまだありません</div>
			) : (
				<div class="card" style="padding:0;overflow-x:auto">
					<table class="tbl">
						<thead>
							<tr>
								<th>名前</th>
								<th>URL 数</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody>
							{tree.map(({ folder: f, depth }) => {
								const subfolders = descendantIds(folders, f.id).length - 1;
								const label = folderLabel(folders, f.id);
								return (
									<tr key={f.id}>
										<td data-label="名前">
											<span class="folder-indent" style={`width:${depth * 20}px`} />
											{f.name}
										</td>
										<td data-label="URL 数">{f.url_count}</td>
										<td data-label="操作">
											<div class="actions">
												<a class="btn btn-s btn-sm" href={`/admin/urls?folder_id=${f.id}`}>
													開く
												</a>
												<a class="btn btn-s btn-sm" href={folderPath(f.id)}>
													編集
												</a>
												<form
													method="post"
													action={folderPath(f.id, "/delete")}
													data-confirm={`フォルダ「${label}」${subfolders ? `とサブフォルダ ${subfolders} 個` : ""}を削除しますか？中の URL は削除されず、未分類に戻ります。`}
												>
													<button type="submit" class="btn btn-d btn-sm">
														削除
													</button>
												</form>
											</div>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</Layout>
	);
}

export function FolderEditPage(props: {
	folder: FolderResponse;
	folders: FolderResponse[];
	flash?: Flash | null;
	values?: FolderValues;
	error?: string;
}) {
	const { folder, folders } = props;
	const values = props.values ?? {
		name: folder.name,
		parent_id: folder.parent_id === null ? "" : String(folder.parent_id),
	};
	const label = folderLabel(folders, folder.id);
	return (
		<Layout title={`編集: ${label}`} section="folders" flash={props.flash}>
			<p class="hint" style="margin:0 0 12px">
				<a href="/admin/folders">← 一覧に戻る</a>
			</p>
			<form class="card stack" method="post" action={folderPath(folder.id)}>
				<h2>{`フォルダを編集: ${label}`}</h2>
				<div class="field">
					<label for="name">名前</label>
					<input id="name" name="name" required maxlength={100} value={values.name} />
				</div>
				<div class="field">
					<label for="parent_id">親フォルダ</label>
					<select id="parent_id" name="parent_id">
						<option value="">（トップレベル）</option>
						<FolderOptions
							folders={folders}
							selected={values.parent_id}
							exclude={descendantIds(folders, folder.id)}
						/>
					</select>
					<p class="hint">自分自身とサブフォルダの中には移動できません。</p>
				</div>
				<FormError message={props.error} />
				<div class="form-actions">
					<a class="btn btn-s" href="/admin/folders">
						キャンセル
					</a>
					<button type="submit" class="btn btn-p">
						保存
					</button>
				</div>
			</form>
		</Layout>
	);
}
