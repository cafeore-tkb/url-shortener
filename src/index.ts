import { Hono } from "hono";
import { authMiddleware } from "./middleware/auth";
import { csrfMiddleware } from "./middleware/csrf";
import { domainMiddleware } from "./middleware/domain";
import adminApp from "./routes/admin";
import domainsApp from "./routes/api/domains";
import foldersApp from "./routes/api/folders";
import urlsApp from "./routes/api/urls";
import redirectApp from "./routes/redirect";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

app.use("*", domainMiddleware);
app.use("/api/*", csrfMiddleware);
app.use("/api/*", authMiddleware);
app.use("/admin", authMiddleware);
app.use("/admin/*", authMiddleware);

app.route("/api", domainsApp);
app.route("/api", foldersApp);
app.route("/api", urlsApp);
app.route("/admin", adminApp);
app.route("/", redirectApp);

export default app;

// Service Binding（名前付きエントリポイント）。詳細は src/service-binding.ts を参照。
export { ShortenerService } from "./service-binding";
