import './bootstrap.js'; // MUST be first — installs proxy dispatcher before any network call
import { assertConfig, config } from './config.js';
import { logger } from './logger.js';
import { createBot } from './whatsapp/bot.js';
import './db/store.js'; // initialize the database/schema on boot

async function main(): Promise<void> {
  try {
    assertConfig();
  } catch (err) {
    logger.error((err as Error).message);
    process.exit(1);
  }

  logger.info(
    {
      model: config.anthropic.model,
      notion: config.notion.hasToken ? config.notion.writeMode : 'no-token',
      dryRun: config.dryRun,
    },
    'starting DADA Ledger Bot…',
  );

  const client = createBot();
  await client.initialize();

  const shutdown = async () => {
    logger.info('shutting down…');
    try {
      await client.destroy();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
