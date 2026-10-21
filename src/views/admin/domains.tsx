import type { DnsRecord } from "../../lib/cloudflare-saas";
import { type DomainResponse, isApex } from "../../routes/api/domains";
import { type Flash, Layout } from "./layout";
import { formatJst } from "./time";

export type DomainCreateValues = { domain: string; name: string; external: boolean };

export type DomainEditValues = {
	name: string;
	gone_title: string;
	gone_message: string;
	gone_color: string;
	gone_logo_url: string;
	external: boolean;
};

const DEFAULT_GONE_COLOR = "#6366F1";
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export function domainPath(domain: string, suffix = ""): string {
	return `/admin/domains/${encodeURIComponent(domain)}${suffix}`;
}

function FormError({ message }: { message?: string }) {
	return message ? (
		<p class="hint hint-err" role="alert">
			{message}
		</p>
	) : null;
}

function StatusPill({ value }: { value: string | null }) {
	if (!value) return <span class="pill pill-expired">不明</span>;
	return <span class={`pill ${value === "active" ? "pill-active" : "pill-expired"}`}>{value}</span>;
}

function DnsTable({ records }: { records: DnsRecord[] }) {
	return (
		<table class="tbl tbl-dns">
			<thead>
				<tr>
					<th>種類</th>
					<th>名前</th>
					<th>値</th>
				</tr>
			</thead>
			<tbody>
				{records.map((r) => (
					<tr key={`${r.type}:${r.name}`}>
						<td data-label="種類">{r.type}</td>
						<td data-label="名前">
							<code>{r.name}</code>
						</td>
						<td data-label="値">
							<code>{r.value}</code>{" "}
							<button type="button" class="copy-btn" data-copy={r.value}>
								コピー
							</button>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/**
 * DNS 設定の注意書き。API（dns_instructions.notes）は英語で返すため、
 * 管理画面では同じ条件から日本語の文言を組み立てる。
 */
function dnsNotes(d: DomainResponse): string[] {
	const ins = d.dns_instructions;
	if (!ins) return [];
	const notes: string[] = [];
	if (!ins.cname_target) {
		notes.push(
			"CF_SAAS_CNAME_TARGET が設定されていません。CNAME の向き先はドメインの管理者に別途伝えてください。",
		);
	}
	if (ins.dcv_delegation_records.length > 0) {
		notes.push(
			"委任用の CNAME は作成後も削除しないでください。証明書を更新するたびに、Cloudflare がその先に新しい DCV トークンを配置します。",
		);
	}
	if (isApex(d.domain)) {
		notes.push(
			"Apex ドメインには通常の CNAME を設定できません。Cloudflare 上のゾーンであれば CNAME flattening を使えますが、それ以外では apex proxying（Enterprise）が必要です。",
		);
	}
	notes.push(
		"ゾーンが Cloudflare 上にある場合、CNAME レコードはプロキシ有効（orange-to-orange）でも DNS のみでも、どちらでもカスタムホスト名が有効になります。",
	);
	return notes;
}

function HostnameBlock({ d }: { d: DomainResponse }) {
	if (!d.external) return null;
	const ins = d.dns_instructions;
	const records = ins?.records ?? [];
	const dcv = ins?.dcv_delegation_records ?? [];
	return (
		<div class="hostname-block">
			<div class="hostname-status">
				ホスト名 <StatusPill value={d.hostname_status} /> &nbsp; SSL{" "}
				<StatusPill value={d.ssl_status} />
			</div>
			{records.length > 0 && (
				<>
					<p class="hint">相手側のアカウントで作成してもらう DNS レコード:</p>
					<DnsTable records={records} />
				</>
			)}
			{dcv.length > 0 && (
				<>
					<p class="hint">
						Delegated DCV（任意）— 上の <code>_acme-challenge</code> の TXT レコードの
						<b>代わりに</b>
						、次の CNAME を作成することもできます。同じ名前に CNAME と TXT
						は共存できないため、どちらか一方だけを作成してください。
					</p>
					<DnsTable records={dcv} />
				</>
			)}
			{dnsNotes(d).map((n) => (
				<p key={n} class="hint">
					{n}
				</p>
			))}
			{d.hostname_checked_at && (
				<p class="hint">{`最終確認: ${formatJst(d.hostname_checked_at)}`}</p>
			)}
		</div>
	);
}

export function DomainsPage(props: {
	domains: DomainResponse[];
	flash?: Flash | null;
	values?: DomainCreateValues;
	error?: string;
}) {
	const { domains, values } = props;
	return (
		<Layout title="ドメイン" section="domains" flash={props.flash}>
			<form class="card" method="post" action="/admin/domains">
				<h2>ドメインを追加</h2>
				<div class="row">
					<div class="field">
						<label for="domain">ドメイン</label>
						<input
							id="domain"
							name="domain"
							required
							placeholder="short.example.com"
							value={values?.domain}
						/>
					</div>
					<div class="field">
						<label for="name">表示名</label>
						<input id="name" name="name" required placeholder="My Brand" value={values?.name} />
					</div>
					<div class="field" style="flex:0 0 auto">
						<span class="field-label">外部ドメイン</span>
						<label class="chk">
							<input type="checkbox" name="external" checked={values?.external} /> 別アカウント
						</label>
					</div>
					<button type="submit" class="btn btn-p">
						追加
					</button>
				</div>
				<FormError message={props.error} />
				<p class="hint">
					DNS ゾーンが別の Cloudflare アカウント（または Cloudflare 以外）にある場合は
					<strong>外部ドメイン</strong>
					にチェックを入れてください。Cloudflare for SaaS のカスタムホスト名として登録し、必要な DNS
					レコードを下に表示します。
				</p>
			</form>

			{domains.length === 0 ? (
				<div class="empty">ドメインが登録されていません</div>
			) : (
				<div class="domain-cards">
					{domains.map((d) => (
						<div key={d.domain} class="domain-card">
							<h3>
								{d.name}
								{d.external && (
									<>
										{" "}
										<span class="pill pill-external">外部</span>
									</>
								)}
							</h3>
							<p>{d.domain}</p>
							<HostnameBlock d={d} />
							<div class="actions">
								<a class="btn btn-s btn-sm" href={domainPath(d.domain)}>
									編集
								</a>
								{d.external && (
									<form method="post" action={domainPath(d.domain, "/refresh")}>
										<button type="submit" class="btn btn-s btn-sm">
											状態を更新
										</button>
									</form>
								)}
								<form
									method="post"
									action={domainPath(d.domain, "/delete")}
									data-confirm={`ドメイン ${d.domain} を削除しますか？URL が残っている場合は削除できません。`}
								>
									<button type="submit" class="btn btn-d btn-sm">
										削除
									</button>
								</form>
							</div>
						</div>
					))}
				</div>
			)}
		</Layout>
	);
}

export function DomainEditPage(props: {
	domain: DomainResponse;
	flash?: Flash | null;
	values?: DomainEditValues;
	error?: string;
}) {
	const d = props.domain;
	const values = props.values ?? {
		name: d.name,
		gone_title: d.gone_title,
		gone_message: d.gone_message,
		gone_color: d.gone_color || DEFAULT_GONE_COLOR,
		gone_logo_url: d.gone_logo_url ?? "",
		external: d.external,
	};
	return (
		<Layout title={`編集: ${d.domain}`} section="domains" flash={props.flash}>
			<p class="hint" style="margin:0 0 12px">
				<a href="/admin/domains">← 一覧に戻る</a>
			</p>
			<form class="card" method="post" action={domainPath(d.domain)}>
				<h2>{`ドメインを編集: ${d.domain}`}</h2>
				<div class="split">
					<div class="stack">
						<div class="field">
							<label for="name">表示名</label>
							<input id="name" name="name" required value={values.name} />
						</div>
						<div class="field">
							<label for="gone_title">410 ページの見出し</label>
							<input
								id="gone_title"
								name="gone_title"
								maxlength={100}
								value={values.gone_title}
								data-preview
							/>
						</div>
						<div class="field">
							<label for="gone_message">410 ページの本文</label>
							<input
								id="gone_message"
								name="gone_message"
								maxlength={500}
								value={values.gone_message}
								data-preview
							/>
						</div>
						<div class="field">
							<label for="gone_color">410 ページのアクセントカラー</label>
							<input
								id="gone_color"
								name="gone_color"
								type="color"
								value={values.gone_color}
								data-preview
							/>
						</div>
						<div class="field">
							<label for="gone_logo_url">410 ページのロゴ URL（任意）</label>
							<input
								id="gone_logo_url"
								name="gone_logo_url"
								type="url"
								placeholder="https://..."
								value={values.gone_logo_url}
								data-preview
							/>
						</div>
						<div class="field">
							<span class="field-label">外部ドメイン</span>
							<label class="chk">
								<input type="checkbox" name="external" checked={values.external} />{" "}
								別アカウント（Cloudflare for SaaS）
							</label>
							<p class="hint">
								オンにするとカスタムホスト名として登録し、相手側に伝える DNS
								レコードを表示します。オフにすると Cloudflare 上のカスタムホスト名を削除します。
							</p>
						</div>
					</div>
					<div>
						<span class="preview-label">410 ページのプレビュー</span>
						<div class="preview" id="gone-preview">
							<div>
								<img
									id="gone-preview-logo"
									src={values.gone_logo_url || undefined}
									hidden={!values.gone_logo_url}
									alt=""
								/>
								<h1
									id="gone-preview-title"
									style={`color:${HEX_COLOR.test(values.gone_color) ? values.gone_color : DEFAULT_GONE_COLOR}`}
								>
									{values.gone_title}
								</h1>
								<p id="gone-preview-message">{values.gone_message}</p>
							</div>
						</div>
					</div>
				</div>
				<FormError message={props.error} />
				<div class="form-actions">
					<a class="btn btn-s" href="/admin/domains">
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
