import './bootstrap.js'; // MUST be first — installs proxy dispatcher before any network call
import { assertConfig, config } from './config.js';
import { logger } from './logger.js';
import { createBot } from './whatsapp/bot.js';
import { refreshFromNotion } from './schedule/weddingSchedule.js';
import './db/store.js'; // initialize the database/schema on boot

const SCHEDULE_REFRESH_MS = 15 * 60 * 1000;

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

  // Load the wedding schedule live from Notion (falls back to the CSV snapshot),
  // then keep it fresh so weddings the team add show up automatically.
  await refreshFromNotion();
  const scheduleTimer = setInterval(() => {
    refreshFromNotion().catch((err) => logger.error({ err }, 'schedule refresh tick failed'));
  }, SCHEDULE_REFRESH_MS);
  scheduleTimer.unref?.();

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
