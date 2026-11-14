import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  createExpressApp,
  runSimulatorScheduledBroadcast,
  seedSimulatorWelcomeIfEmpty
} from './server/app.js';
import {
  addBotLog,
  ensureDatabaseLoaded,
  flushDatabaseToFirebase,
  getDb,
  loadDatabase
} from './server/storage.js';
import { startDailyScheduler, startTelegramBot } from './server/telegramBot.js';

async function bootstrap() {
  loadDatabase();
  const app = createExpressApp();

  await ensureDatabaseLoaded();
  const seeded = await seedSimulatorWelcomeIfEmpty();
  if (seeded) {
    await flushDatabaseToFirebase();
  }

  // Frontend Vite / Static serving
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`[Server] Дядя Деп UI & Bot server listening on http://localhost:${PORT}`);
    addBotLog({
      source: 'scheduler',
      chatId: 'system',
      chatTitle: 'Сервер',
      event: 'Сервер запущен',
      detail: `Порт ${PORT}, часовой пояс ${getDb().timezone}`
    });

    // Launch live Telegram bot on startup unless local polling was manually paused
    if (!getDb().localPollingPaused) {
      await startTelegramBot();
    } else {
      addBotLog({
        source: 'telegram',
        chatId: 'system',
        chatTitle: 'Telegram Polling',
        event: 'Polling на паузе',
        detail: 'Автозапуск локального бота отключён (удобно для теста Webhook на Vercel)'
      });
    }

    // Launch 12:00 / 12:01 / 20:55 / 21:00 scheduler & 5-minute auto-delete cleanup
    startDailyScheduler(runSimulatorScheduledBroadcast);
  });
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal error:', err);
  process.exit(1);
});
