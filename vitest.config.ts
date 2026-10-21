import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
	const migrationsPath = path.join(__dirname, "migrations");
	const migrations = await readD1Migrations(migrationsPath);

	return {
		test: {
			poolOptions: {
				workers: {
					miniflare: {
						bindings: { TEST_MIGRATIONS: migrations },
						// 自分自身の名前付きエントリポイントへの Service Binding（test/integration/service-binding.test.ts 用）。
						// Symbol.for("miniflare.kCurrentWorker") は miniflare の kCurrentWorker と同じシンボル。
						serviceBindings: {
							SHORTENER: {
								name: Symbol.for("miniflare.kCurrentWorker"),
								entrypoint: "ShortenerService",
							},
						},
					},
					wrangler: {
						configPath: "./wrangler.jsonc",
					},
				},
			},
		},
	};
});
