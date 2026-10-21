function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#x27;");
}

export function render410Page({
	title,
	message,
	color,
	logoUrl,
}: {
	title: string;
	message: string;
	color: string;
	logoUrl: string | null;
}): string {
	const safeTitle = escapeHtml(title);
	const safeMessage = escapeHtml(message);
	const safeColor = /^#[0-9A-Fa-f]{6}$/.test(color) ? color : "#000000";
	const logoHtml = logoUrl
		? `<img src="${escapeHtml(logoUrl)}" alt="" style="max-width:120px;max-height:120px;margin-bottom:24px">`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f9fafb;color:#111827;text-align:center;padding:24px}
h1{color:${safeColor};font-size:1.5rem;margin-bottom:12px}
p{color:#6b7280;font-size:1rem;line-height:1.5}
@media(prefers-color-scheme:dark){
body{background:#111827;color:#f9fafb}
p{color:#9ca3af}
}
</style>
</head>
<body>
<div>${logoHtml}<h1>${safeTitle}</h1><p>${safeMessage}</p></div>
</body>
</html>`;
}
