import { raw } from "hono/html";
import type { PropsWithChildren } from "hono/jsx";

/** 操作結果のメッセージ。POST → リダイレクト後の画面で 1 回だけ表示する */
export type Flash = { kind: "ok" | "error"; message: string };

export type AdminSection = "urls" | "folders" | "domains" | "import";

const CSS = `
:root{
--bg:#f9fafb;--bg2:#ffffff;--bg3:#f3f4f6;
--fg:#111827;--fg2:#6b7280;--fg3:#9ca3af;
--border:#e5e7eb;--radius:8px;--shadow:0 1px 3px rgba(0,0,0,.1);
--accent:#6366f1;--accent-hover:#4f46e5;
--green:#059669;--red:#dc2626;--yellow:#d97706;
--space:16px;
}
@media(prefers-color-scheme:dark){
:root{
--bg:#111827;--bg2:#1f2937;--bg3:#374151;
--fg:#f9fafb;--fg2:#9ca3af;--fg3:#6b7280;
--border:#374151;--shadow:0 1px 3px rgba(0,0,0,.4);
}
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.hdr{background:var(--bg2);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;justify-content:space-between}
.hdr h1{font-size:1.1rem;font-weight:600}
.hdr h1 a{color:var(--fg)}
.nav{display:flex;gap:4px;flex-wrap:wrap;justify-content:center}
.nav a{padding:6px 14px;border-radius:var(--radius);font-size:.875rem;font-weight:500;color:var(--fg2);text-decoration:none;white-space:nowrap}
.nav a.active{background:var(--accent);color:#fff}
.nav a:hover:not(.active){background:var(--bg3)}
.wrap{max-width:1100px;margin:0 auto;padding:24px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space);margin-bottom:var(--space);box-shadow:var(--shadow)}
.card h2{font-size:.95rem;margin-bottom:12px;font-weight:600}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:140px}
.field>label,.field-label{font-size:.75rem;font-weight:500;color:var(--fg2)}
.stack .field{margin-bottom:12px}
input,select,textarea{padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--fg);font-size:.875rem;outline:none;font-family:inherit}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(99,102,241,.15)}
textarea{resize:vertical;min-height:60px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:7px 14px;border:none;border-radius:var(--radius);font-size:.8rem;font-weight:500;cursor:pointer;transition:background .15s;font-family:inherit;text-decoration:none}
.btn:hover{text-decoration:none}
.btn-p{background:var(--accent);color:#fff}.btn-p:hover{background:var(--accent-hover)}
.btn-d{background:var(--red);color:#fff}.btn-d:hover{background:#b91c1c}
.btn-s{background:var(--bg3);color:var(--fg)}.btn-s:hover{background:var(--border)}
.btn-sm{padding:4px 10px;font-size:.75rem}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:.7rem;font-weight:600;white-space:nowrap}
.pill-active{background:#d1fae5;color:#065f46}
.pill-expired{background:#fef3c7;color:#92400e}
.pill-deleted{background:#fee2e2;color:#991b1b}
.pill-external{background:#e0e7ff;color:#3730a3}
@media(prefers-color-scheme:dark){
.pill-active{background:#064e3b;color:#6ee7b7}
.pill-expired{background:#78350f;color:#fde68a}
.pill-deleted{background:#7f1d1d;color:#fca5a5}
.pill-external{background:#312e81;color:#c7d2fe}
}
.chk{display:flex;align-items:center;gap:6px;font-size:.8rem;color:var(--fg);padding:7px 0;white-space:nowrap}
.chk input{width:auto}
.hint{font-size:.75rem;color:var(--fg2);margin-top:8px;line-height:1.5}
.hint-err{color:var(--red)}
.flash{padding:10px 16px;border-radius:var(--radius);color:#fff;font-size:.85rem;margin-bottom:var(--space);box-shadow:var(--shadow);word-break:break-all}
.flash-ok{background:var(--green)}
.flash-error{background:var(--red)}
.hostname-block{border-top:1px solid var(--border);margin:8px 0;padding-top:8px}
.hostname-status{font-size:.75rem;color:var(--fg2);display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.tbl-dns{margin-top:6px;font-size:.72rem;table-layout:fixed}
.tbl-dns th,.tbl-dns td{padding:4px 6px}
.tbl-dns code{word-break:break-all;font-size:.7rem}
.tbl{width:100%;border-collapse:collapse;font-size:.85rem}
.tbl th{text-align:left;padding:8px 10px;border-bottom:2px solid var(--border);font-size:.75rem;color:var(--fg2);font-weight:600;white-space:nowrap}
.tbl td{padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
.tbl tr:last-child td{border-bottom:none}
.tbl-url{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.actions{display:flex;gap:4px;flex-wrap:wrap}
.actions form{display:inline}
.pager{display:flex;justify-content:center;align-items:center;gap:12px;margin-top:var(--space);font-size:.85rem;color:var(--fg2)}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.split{display:flex;gap:20px}
.split>div{flex:1;min-width:0}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:.85rem;margin-bottom:16px}
.meta dt{color:var(--fg2)}
.preview{border:1px solid var(--border);border-radius:var(--radius);padding:24px;text-align:center;background:var(--bg);min-height:160px;display:flex;align-items:center;justify-content:center}
.preview h1{font-size:1.2rem;margin-bottom:8px}
.preview p{color:var(--fg2);font-size:.9rem}
.preview img{max-width:80px;max-height:80px;margin-bottom:12px}
.preview-label{font-size:.75rem;font-weight:500;color:var(--fg2);display:block;margin-bottom:8px}
.copy-btn{cursor:pointer;background:none;border:none;color:var(--accent);font-size:.75rem;padding:2px 4px;font-family:inherit}
.copy-btn:hover{text-decoration:underline}
.filter-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:var(--space)}
.filter-bar input,.filter-bar select{max-width:200px}
.domain-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:var(--space)}
.domain-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space);box-shadow:var(--shadow)}
.domain-card h3{font-size:.9rem;margin-bottom:4px}
.domain-card p{font-size:.8rem;color:var(--fg2);margin-bottom:8px}
.folder-indent{display:inline-block}
.folder-path{font-size:.75rem;color:var(--fg2)}
.empty{text-align:center;padding:40px;color:var(--fg3);font-size:.9rem}
.tbl tr.row-err td{background:rgba(220,38,38,.06)}
.errs{color:var(--red);font-size:.75rem;padding-left:1.2em;line-height:1.5}
.notes{font-size:.75rem;color:var(--fg2);margin-top:12px;padding-left:1.4em;line-height:1.7}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8rem}
@media(max-width:768px){
.tbl thead{display:none}
.tbl tr{display:block;margin-bottom:12px;border:1px solid var(--border);border-radius:var(--radius);padding:8px}
.tbl td{display:flex;justify-content:space-between;padding:4px 8px;border-bottom:none}
.tbl td::before{content:attr(data-label);font-weight:600;font-size:.75rem;color:var(--fg2);margin-right:8px}
.tbl-url{max-width:160px}
.split{flex-direction:column}
.hdr{flex-direction:column;gap:8px}
}`;

/**
 * 画面はサーバー側でレンダリングし、操作はすべて通常のフォーム送信で行う。
 * このスクリプトは JS が使えるときの補助（確認ダイアログ・コピー・フィルタの自動送信・
 * 410 ページのプレビュー）だけを担い、無くても全機能が使える（コピーを除く）。
 */
const SCRIPT = `(function(){
'use strict';
document.addEventListener('submit',function(e){
var m=e.target.getAttribute('data-confirm');
if(m&&!window.confirm(m))e.preventDefault();
});
document.addEventListener('click',function(e){
var b=e.target.closest('[data-copy]');
if(!b)return;
navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){
var t=b.textContent;b.textContent='コピーしました';setTimeout(function(){b.textContent=t},1500);
},function(){window.alert('コピーできませんでした')});
});
document.addEventListener('change',function(e){
var el=e.target;
if(el.hasAttribute('data-autosubmit')&&el.form)el.form.requestSubmit?el.form.requestSubmit():el.form.submit();
});
var preview=document.getElementById('gone-preview');
if(preview){
var title=document.getElementById('gone-preview-title');
var msg=document.getElementById('gone-preview-message');
var logo=document.getElementById('gone-preview-logo');
var val=function(id){var el=document.getElementById(id);return el?el.value:''};
document.addEventListener('input',function(e){
if(!e.target.hasAttribute('data-preview'))return;
title.textContent=val('gone_title');
title.style.color=val('gone_color');
msg.textContent=val('gone_message');
var src=val('gone_logo_url').trim();
if(src){logo.src=src;logo.hidden=false}else{logo.removeAttribute('src');logo.hidden=true}
});
}
})();`;

const NAV: { section: AdminSection; href: string; label: string }[] = [
	{ section: "urls", href: "/admin/urls", label: "短縮 URL" },
	{ section: "folders", href: "/admin/folders", label: "フォルダ" },
	{ section: "domains", href: "/admin/domains", label: "ドメイン" },
	{ section: "import", href: "/admin/import", label: "CSV インポート" },
];

export function Layout({
	title,
	section,
	flash,
	children,
}: PropsWithChildren<{ title: string; section: AdminSection; flash?: Flash | null }>) {
	return (
		<>
			{raw("<!DOCTYPE html>")}
			<html lang="ja">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width,initial-scale=1" />
					<title>{`${title} | URL 短縮 管理画面`}</title>
					<style>{raw(CSS)}</style>
				</head>
				<body>
					<header class="hdr">
						<h1>
							<a href="/admin/urls">URL 短縮 管理画面</a>
						</h1>
						<nav class="nav">
							{NAV.map((item) => (
								<a
									key={item.section}
									href={item.href}
									class={item.section === section ? "active" : undefined}
									aria-current={item.section === section ? "page" : undefined}
								>
									{item.label}
								</a>
							))}
						</nav>
					</header>
					<main class="wrap">
						{flash && (
							<div
								class={`flash flash-${flash.kind}`}
								role={flash.kind === "error" ? "alert" : "status"}
							>
								{flash.message}
							</div>
						)}
						{children}
					</main>
					<script>{raw(SCRIPT)}</script>
				</body>
			</html>
		</>
	);
}
