import { readFileSync } from 'node:fs';
import { defaultConfig } from '../core/config.js';
import { runAudit } from '../pipeline/pipeline.js';

try {
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const config = defaultConfig(input.url, {
    dbPath: input.dbPath, rawDir: input.rawDir, outDir: input.outDir, logLevel: 'error',
  });
  config.crawl.maxPages = input.maxPages;
  config.crawl.concurrency = 2;
  config.crawl.allowedOrigins = [new URL(input.url).origin];
  const result = await runAudit(config, { profile: 'on-page' });
  result.store.close();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
