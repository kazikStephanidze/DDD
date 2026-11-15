import express from 'express';
import {
  BotTransport,
  InlineKeyboard,
  getActiveRussianLobbiesForChat,
  getPlayerCollectionSummary,
  handleCallback,
  handleCommand,
  handleTextMessage,
  isProtectedInteractiveMessage,
  sendDailyEveningReportBroadcast,
  sendDailyHoroscopeBroadcast,
  sendDailyLeaderboardBroadcast,
  sweepExpiredLobbies
} from './botEngine.js';
import { sendDailyLotteryDrawBroadcast } from './features/lottery.js';
import { sendChatBlitzBroadcast } from './features/blitz.js';
import { PHRASE_POOLS, getPhraseCatalogStats, pickRandom } from './phrases.js';
import {
  isRuntimeDirty,
  isServerlessRuntime,
  markRuntimeDirty,
  registerRuntimeAdapter,
  registerTransportResolver
} from './runtimeRegistry.js';
import {
  BOT_MESSAGE_TTL_MS,
  claimTelegramUpdateId,
  ensureDatabaseLoaded,
  flushDatabaseToFirebase,
  getBotLogs,
  getDb,
  getFirebaseStatus,
  getOrCreateChat,
  getZonedDateTimeParts,
  pruneFirebaseArchives,
  scheduleSave,
  setLocalPollingPaused,
  setTelegramToken,
  setTimezone
} from './storage.js';
import {
  getActiveTelegramTransport,
  getTelegramStatus,
  handleTelegramWebhook,
  refreshServerlessTelegramStatus,
  runScheduledTasksNow,
  setupTelegramWebhook,
  startTelegramBot,
  stopTelegramBot
} from './telegramBot.js';

export interface SimMessage {
  id: string;
  sender: 'bot' | 'user';
  senderName: string;
  text: string;
  keyboard?: InlineKeyboard;
  timestamp: number;
  diceValue?: number;
}

const simMessagesByChat = new Map<string, SimMessage[]>();
let lastSimToast: { text: string; isAlert: boolean; id: string } | null = null;

function getSimMessages(chatId: string): SimMessage[] {
  let list = simMessagesByChat.get(chatId);
  if (!list) {
    list = [];
    simMessagesByChat.set(chatId, list);
  }
  const now = Date.now();
  const filtered = list.filter(
    (m) => m.sender !== 'bot' || isProtectedInteractiveMessage(m.id) || now - m.timestamp < BOT_MESSAGE_TTL_MS
  );
  if (filtered.length !== list.length) {
    simMessagesByChat.set(chatId, filtered);
    markRuntimeDirty();
    return filtered;
  }
  return list;
}

function pushSimMessage(chatId: string, msg: Omit<SimMessage, 'id' | 'timestamp'>): string {
  const id = `sim-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const list = getSimMessages(chatId);
  list.push({
    id,
    timestamp: Date.now(),
    ...msg
  });
  if (list.length > 25) {
    simMessagesByChat.set(chatId, list.slice(-25));
  }
  markRuntimeDirty();
  return id;
}

export const simulatorTransport: BotTransport = {
  source: 'simulator',
  getRollDelayMs: () => (isServerlessRuntime() ? 250 : 550),
  async sendMessage(chatId: string, text: string, keyboard?: InlineKeyboard): Promise<string | null> {
    return pushSimMessage(chatId, {
      sender: 'bot',
      senderName: 'Дядя Деп',
      text,
      keyboard
    });
  },
  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    keyboard?: InlineKeyboard,
    _options?: { isAnimation?: boolean }
  ): Promise<void> {
    const list = getSimMessages(chatId);
    const target = list.find((m) => m.id === messageId);
    if (target) {
      target.text = text;
      target.keyboard = keyboard;
      target.timestamp = Date.now();
      markRuntimeDirty();
    } else {
      pushSimMessage(chatId, {
        sender: 'bot',
        senderName: 'Дядя Деп',
        text,
        keyboard
      });
    }
  },
  async sendDice(chatId: string, emoji: '🎲' | '🎰' = '🎲'): Promise<{ value: number; messageId: string | null }> {
    const isSlot = emoji === '🎰';
    const value = Math.floor(Math.random() * (isSlot ? 64 : 6)) + 1;
    const msgId = pushSimMessage(chatId, {
      sender: 'bot',
      senderName: 'Дядя Деп',
      text: isSlot ? `🎰 Барабан слота крутится... (код #${value})` : `🎲 Кубик брошен: выпало ${value}`,
      diceValue: value
    });
    return { value, messageId: msgId };
  },
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!messageId) return;
    const list = simMessagesByChat.get(chatId);
    if (!list) return;
    const next = list.filter((m) => m.id !== messageId);
    if (next.length !== list.length) {
      simMessagesByChat.set(chatId, next);
      markRuntimeDirty();
    }
  },
  async answerCallback(_callbackId: string, text?: string, showAlert?: boolean): Promise<void> {
    if (text) {
      lastSimToast = {
        text,
        isAlert: Boolean(showAlert),
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
      };
      markRuntimeDirty();
    }
  }
};

registerTransportResolver((source) =>
  source === 'simulator' ? simulatorTransport : getActiveTelegramTransport()
);

registerRuntimeAdapter('simulator', {
  exportState: () => ({
    messagesByChat: Array.from(simMessagesByChat.entries()).map(([chatId, msgs]) => [
      chatId,
      msgs.slice(-20)
    ]),
    lastSimToast
  }),
  importState: (raw: any) => {
    simMessagesByChat.clear();
    if (Array.isArray(raw?.messagesByChat)) {
      for (const entry of raw.messagesByChat) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])) {
          simMessagesByChat.set(entry[0], entry[1].slice(-25));
        }
      }
    }
    lastSimToast = raw?.lastSimToast && typeof raw.lastSimToast.text === 'string' ? raw.lastSimToast : null;
  }
});

export async function seedSimulatorWelcomeIfEmpty(): Promise<boolean> {
  const simChatId = 'sim-chat-1';
  const simChat = getOrCreateChat(simChatId, 'Чат «Дядя Деп и пацаны» (Симулятор)', 'simulator');
  const simUser = simChat.players['sim-user-1'];
  if (simUser && getSimMessages(simChatId).length === 0) {
    await handleCommand(
      simulatorTransport,
      { chatId: simChatId, title: simChat.title, type: 'simulator' },
      { userId: simUser.userId, firstName: simUser.firstName, username: simUser.username },
      '/start'
    );
    return true;
  }
  return false;
}

export async function runSimulatorScheduledBroadcast(
  type: 'horoscope' | 'leaderboard' | 'evening' | 'lottery',
  chatId: string
): Promise<void> {
  if (type === 'horoscope') {
    await sendDailyHoroscopeBroadcast(simulatorTransport, chatId);
  } else if (type === 'leaderboard') {
    await sendDailyLeaderboardBroadcast(simulatorTransport, chatId);
  } else if (type === 'lottery') {
    await sendDailyLotteryDrawBroadcast(simulatorTransport, chatId);
  } else {
    await sendDailyEveningReportBroadcast(simulatorTransport, chatId);
  }
}

function deriveWebhookUrlFromRequest(req: express.Request, customUrl?: string): string | null {
  if (customUrl && typeof customUrl === 'string' && customUrl.trim().startsWith('http')) {
    return customUrl.trim().replace(/\/+$/, '');
  }
  const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '') as string;
  if (!forwardedHost) return null;
  const host = forwardedHost.split(',')[0].trim();
  const protoHeader = (req.headers['x-forwarded-proto'] || '') as string;
  const proto = protoHeader ? protoHeader.split(',')[0].trim() : host.includes('localhost') ? 'http' : 'https';
  if (proto !== 'https' && !process.env.APP_URL?.startsWith('https://')) {
    return null;
  }
  const base = process.env.APP_URL?.startsWith('https://')
    ? process.env.APP_URL.replace(/\/+$/, '')
    : `https://${host}`;
  return `${base}/api/telegram/webhook`;
}

export function createExpressApp(): express.Express {
  const app = express();

  // Vercel Node runtime may pre-parse JSON bodies into req.body before Express sees them.
  app.use((req, res, next) => {
    if (req.body !== undefined) {
      next();
      return;
    }
    express.json({ limit: '1mb' })(req, res, next);
  });

  app.get('/api/status', async (_req, res) => {
    try {
      await ensureDatabaseLoaded({ minIntervalMs: 5000, includeLogs: true, includePhraseArchive: false });
      const db = getDb();
      const tg = isServerlessRuntime()
        ? await refreshServerlessTelegramStatus()
        : getTelegramStatus();

      const chatsList = Object.values(db.chats).map((c) => ({
        chatId: c.chatId,
        title: c.title,
        type: c.type,
        lastHoroscopeDate: c.lastHoroscopeDate,
        lastLeaderboardDate: c.lastLeaderboardDate,
        lastEveningReportDate: c.lastEveningReportDate,
        lastAutoChatReplyAt: c.lastAutoChatReplyAt,
        usedQuotesCount: c.usedPhraseCount ?? (c.usedPhraseKeys || []).length,
        lotteryTicketsCount: c.lottery?.tickets?.length || 0,
        players: Object.values(c.players).map((p) => ({
          ...p,
          collectionSummary: getPlayerCollectionSummary(p)
        })),
        loans: (c.loans || []).filter((l) => l.status === 'active')
      }));

      res.json({
        telegram: tg,
        firebase: getFirebaseStatus(),
        timezone: db.timezone,
        zonedNow: getZonedDateTimeParts(db.timezone),
        catalogStats: getPhraseCatalogStats(),
        chats: chatsList,
        logs: getBotLogs()
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Status failed' });
    }
  });

  app.post('/api/bot/config', async (req, res) => {
    try {
      await ensureDatabaseLoaded({ forceRemote: true });
      const { token, timezone } = (req.body || {}) as { token?: string; timezone?: string };
      if (timezone && typeof timezone === 'string' && timezone.trim()) {
        setTimezone(timezone.trim());
      }
      if (token && typeof token === 'string' && token.trim().length > 10) {
        const cleanToken = token.trim();
        process.env.TELEGRAM_BOT_TOKEN = cleanToken;
        setTelegramToken(cleanToken);

        let tg;
        if (isServerlessRuntime()) {
          const webhookUrl = deriveWebhookUrlFromRequest(req);
          tg = webhookUrl
            ? await setupTelegramWebhook(webhookUrl, cleanToken)
            : await refreshServerlessTelegramStatus();
        } else {
          setLocalPollingPaused(false);
          tg = await startTelegramBot(cleanToken);
        }
        await flushDatabaseToFirebase();
        res.json({ ok: true, telegram: tg, timezone: getDb().timezone, firebase: getFirebaseStatus() });
        return;
      }
      await flushDatabaseToFirebase();
      const tg = isServerlessRuntime()
        ? await refreshServerlessTelegramStatus()
        : getTelegramStatus();
      res.json({ ok: true, telegram: tg, timezone: getDb().timezone, firebase: getFirebaseStatus() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Config update failed' });
    }
  });

  app.post('/api/bot/restart', async (req, res) => {
    try {
      await ensureDatabaseLoaded({ forceRemote: true });
      let tg;
      if (isServerlessRuntime()) {
        const webhookUrl = deriveWebhookUrlFromRequest(req);
        tg = webhookUrl
          ? await setupTelegramWebhook(webhookUrl)
          : await refreshServerlessTelegramStatus();
      } else {
        setLocalPollingPaused(false);
        tg = await startTelegramBot();
      }
      await flushDatabaseToFirebase();
      res.json({ ok: true, telegram: tg });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Restart failed' });
    }
  });

  app.post('/api/bot/stop', async (_req, res) => {
    try {
      await ensureDatabaseLoaded({ forceRemote: true });
      if (!isServerlessRuntime()) {
        setLocalPollingPaused(true);
        await stopTelegramBot();
        await flushDatabaseToFirebase();
      }
      const tg = isServerlessRuntime()
        ? await refreshServerlessTelegramStatus()
        : getTelegramStatus();
      res.json({ ok: true, telegram: tg });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Stop failed' });
    }
  });

  app.post('/api/bot/webhook/setup', async (req, res) => {
    try {
      await ensureDatabaseLoaded({ forceRemote: true });
      const { webhookUrl: customUrl, token } = (req.body || {}) as {
        webhookUrl?: string;
        token?: string;
      };
      const targetUrl = deriveWebhookUrlFromRequest(req, customUrl);
      if (!targetUrl) {
        res.status(400).json({
          ok: false,
          error: 'Для установки Telegram Webhook нужен HTTPS-домен (например, после деплоя на Vercel).'
        });
        return;
      }
      if (token && typeof token === 'string' && token.trim().length > 10) {
        const cleanToken = token.trim();
        process.env.TELEGRAM_BOT_TOKEN = cleanToken;
        setTelegramToken(cleanToken);
      }
      const tg = await setupTelegramWebhook(targetUrl, token);
      await flushDatabaseToFirebase();
      res.json({ ok: tg.running, telegram: tg, webhookUrl: targetUrl });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Webhook setup failed' });
    }
  });

  app.post('/api/telegram/webhook', async (req, res) => {
    let targetChatId: string | undefined;
    try {
      const update = req.body;
      if (!update || typeof update !== 'object') {
        res.status(200).json({ ok: false, error: 'Empty update payload' });
        return;
      }

      const updateId = typeof update.update_id === 'number' ? update.update_id : null;
      if (updateId !== null) {
        const claimed = await claimTelegramUpdateId(updateId);
        if (!claimed) {
          res.status(200).json({ ok: true, duplicate: true });
          return;
        }
      }

      const rawChatId =
        update?.message?.chat?.id ??
        update?.callback_query?.message?.chat?.id ??
        update?.edited_message?.chat?.id;
      targetChatId = rawChatId !== undefined && rawChatId !== null ? String(rawChatId) : undefined;

      await ensureDatabaseLoaded({
        forceRemote: true,
        targetChatId,
        includeLogs: false,
        includePhraseArchive: true
      });
      const result = await handleTelegramWebhook(update);
      await sweepExpiredLobbies();
      await flushDatabaseToFirebase(false, targetChatId);
      res.status(200).json(result);
    } catch (err: any) {
      console.error('[Webhook] Error processing Telegram update:', err?.message || err);
      await flushDatabaseToFirebase(false, targetChatId).catch(() => {});
      res.status(200).json({ ok: false, error: err?.message || 'Webhook handler error' });
    }
  });

  const handleCron = async (req: express.Request, res: express.Response) => {
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    if (cronSecret) {
      const authHeader = String(req.headers.authorization || '');
      const querySecret = String(req.query.secret || '');
      if (authHeader !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
        res.status(401).json({ ok: false, error: 'Unauthorized cron call' });
        return;
      }
    }

    try {
      await ensureDatabaseLoaded({ forceRemote: true, includePhraseArchive: true, includeLogs: false });
      const result = await runScheduledTasksNow(runSimulatorScheduledBroadcast);
      await flushDatabaseToFirebase();
      await pruneFirebaseArchives();
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error('[Cron] Execution failed:', err?.message || err);
      res.status(500).json({ ok: false, error: err?.message || 'Cron execution failed' });
    }
  };

  app.get('/api/cron', handleCron);
  app.post('/api/cron', handleCron);

  app.get('/api/sim/messages', async (req, res) => {
    try {
      const chatId = String(req.query.chatId || 'sim-chat-1');
      await ensureDatabaseLoaded({
        minIntervalMs: 1500,
        targetChatId: chatId,
        includeLogs: false,
        includePhraseArchive: true
      });
      if (chatId === 'sim-chat-1' && getSimMessages(chatId).length === 0) {
        const seeded = await seedSimulatorWelcomeIfEmpty();
        if (seeded) await flushDatabaseToFirebase(false, chatId);
      }
      await sweepExpiredLobbies();
      if (isRuntimeDirty()) {
        await flushDatabaseToFirebase(false, chatId);
      }
      const chat = getDb().chats[chatId];
      res.json({
        messages: getSimMessages(chatId),
        toast: lastSimToast,
        players: chat ? Object.values(chat.players) : [],
        activeLobbies: getActiveRussianLobbiesForChat(chatId)
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load simulator messages' });
    }
  });

  app.post('/api/sim/command', async (req, res) => {
    try {
      const { chatId = 'sim-chat-1', userId = 'sim-user-1', command = '/start' } = req.body || {};
      await ensureDatabaseLoaded({ forceRemote: true, targetChatId: chatId, includeLogs: false });
      const chat = getOrCreateChat(chatId, 'Чат «Дядя Деп и пацаны» (Симулятор)', 'simulator');
      const p = chat.players[userId] || { userId, firstName: 'Игрок', username: 'player' };

      pushSimMessage(chatId, {
        sender: 'user',
        senderName: p.firstName,
        text: command
      });

      await handleCommand(
        simulatorTransport,
        { chatId, title: chat.title, type: 'simulator' },
        { userId: p.userId, firstName: p.firstName, username: p.username },
        command
      );

      await sweepExpiredLobbies();
      await flushDatabaseToFirebase(false, chatId);

      res.json({
        messages: getSimMessages(chatId),
        toast: lastSimToast,
        players: Object.values(chat.players)
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Command failed' });
    }
  });

  app.post('/api/sim/callback', async (req, res) => {
    try {
      const { chatId = 'sim-chat-1', userId = 'sim-user-1', messageId, callbackData } = req.body || {};
      await ensureDatabaseLoaded({ forceRemote: true, targetChatId: chatId, includeLogs: false });
      const chat = getOrCreateChat(chatId, 'Чат «Дядя Деп и пацаны» (Симулятор)', 'simulator');
      const p = chat.players[userId] || { userId, firstName: 'Игрок', username: 'player' };

      lastSimToast = null;
      markRuntimeDirty();
      await handleCallback(
        simulatorTransport,
        { chatId, title: chat.title, type: 'simulator' },
        { userId: p.userId, firstName: p.firstName, username: p.username },
        `sim-cb-${Date.now()}`,
        String(messageId || ''),
        String(callbackData || 'menu')
      );

      await sweepExpiredLobbies();
      await flushDatabaseToFirebase(false, chatId);

      res.json({
        messages: getSimMessages(chatId),
        toast: lastSimToast,
        players: Object.values(chat.players)
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Callback failed' });
    }
  });

  app.post('/api/sim/message', async (req, res) => {
    try {
      const {
        chatId = 'sim-chat-1',
        userId = 'sim-user-1',
        text = '',
        bypassCooldown = true,
        forceTrigger = false
      } = req.body || {};
      await ensureDatabaseLoaded({ forceRemote: true, targetChatId: chatId, includeLogs: false });
      const chat = getOrCreateChat(chatId, 'Чат «Дядя Деп и пацаны» (Симулятор)', 'simulator');
      const p = chat.players[userId] || { userId, firstName: 'Игрок', username: 'player' };

      pushSimMessage(chatId, {
        sender: 'user',
        senderName: p.firstName,
        text
      });

      let triggered = false;
      if (text.startsWith('/')) {
        await handleCommand(
          simulatorTransport,
          { chatId, title: chat.title, type: 'simulator' },
          { userId: p.userId, firstName: p.firstName, username: p.username },
          text
        );
        triggered = true;
      } else {
        triggered = await handleTextMessage(
          simulatorTransport,
          { chatId, title: chat.title, type: 'simulator' },
          { userId: p.userId, firstName: p.firstName, username: p.username },
          text,
          { bypassCooldown: Boolean(bypassCooldown), forceTrigger: Boolean(forceTrigger) }
        );
      }

      await sweepExpiredLobbies();
      await flushDatabaseToFirebase(false, chatId);

      res.json({
        triggered,
        messages: getSimMessages(chatId),
        toast: lastSimToast,
        players: Object.values(chat.players)
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Message failed' });
    }
  });

  app.post('/api/sim/set-zero', async (req, res) => {
    try {
      const { chatId = 'sim-chat-1', userId = 'sim-user-1' } = req.body || {};
      await ensureDatabaseLoaded({ forceRemote: true, targetChatId: chatId, includeLogs: false });
      const chat = getDb().chats[chatId];
      if (chat && chat.players[userId]) {
        chat.players[userId].balance = 0;
        scheduleSave();
      }
      await flushDatabaseToFirebase(false, chatId);
      res.json({ ok: true, players: chat ? Object.values(chat.players) : [] });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Set zero failed' });
    }
  });

  app.post('/api/sim/clear', async (req, res) => {
    try {
      const { chatId = 'sim-chat-1', userId = 'sim-user-1' } = req.body || {};
      await ensureDatabaseLoaded({ forceRemote: true, targetChatId: chatId, includeLogs: false });
      simMessagesByChat.set(chatId, []);
      lastSimToast = null;
      markRuntimeDirty();
      const chat = getOrCreateChat(chatId);
      const p = chat.players[userId] || { userId, firstName: 'Игрок', username: 'player' };
      await handleCommand(
        simulatorTransport,
        { chatId, title: chat.title, type: 'simulator' },
        { userId: p.userId, firstName: p.firstName, username: p.username },
        '/start'
      );
      await flushDatabaseToFirebase(false, chatId);
      res.json({ messages: getSimMessages(chatId) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Clear failed' });
    }
  });

  app.post('/api/broadcast/test', async (req, res) => {
    try {
      await ensureDatabaseLoaded({ forceRemote: true, includePhraseArchive: true, includeLogs: false });
      const { type = 'both', includeTelegram = false } = req.body || {};
      const simId = 'sim-chat-1';
      if (type === 'horoscope' || type === 'both' || type === 'all') {
        await sendDailyHoroscopeBroadcast(simulatorTransport, simId);
      }
      if (type === 'leaderboard' || type === 'both' || type === 'all') {
        await sendDailyLeaderboardBroadcast(simulatorTransport, simId);
      }
      if (type === 'lottery' || type === 'all') {
        await sendDailyLotteryDrawBroadcast(simulatorTransport, simId);
      }
      if (type === 'evening' || type === 'all') {
        await sendDailyEveningReportBroadcast(simulatorTransport, simId);
      }
      if (type === 'blitz' || type === 'all') {
        await sendChatBlitzBroadcast(simulatorTransport, simId);
      }

      let telegramSentCount = 0;
      if (includeTelegram) {
        const tg = getActiveTelegramTransport();
        if (tg) {
          for (const c of Object.values(getDb().chats)) {
            if (c.type === 'simulator' || Object.keys(c.players).length === 0) continue;
            if (type === 'horoscope' || type === 'both' || type === 'all') {
              await sendDailyHoroscopeBroadcast(tg, c.chatId);
            }
            if (type === 'leaderboard' || type === 'both' || type === 'all') {
              await sendDailyLeaderboardBroadcast(tg, c.chatId);
            }
            if (type === 'lottery' || type === 'all') {
              await sendDailyLotteryDrawBroadcast(tg, c.chatId);
            }
            if (type === 'evening' || type === 'all') {
              await sendDailyEveningReportBroadcast(tg, c.chatId);
            }
            if (type === 'blitz' || type === 'all') {
              await sendChatBlitzBroadcast(tg, c.chatId);
            }
            telegramSentCount++;
          }
        }
      }

      await flushDatabaseToFirebase();
      res.json({
        ok: true,
        telegramSentCount,
        messages: getSimMessages(simId)
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Broadcast failed' });
    }
  });

  app.post('/api/phrases/sample', (_req, res) => {
    res.json({
      quote: pickRandom(PHRASE_POOLS.liveChatQuotes),
      guidance: pickRandom(PHRASE_POOLS.dailyGuidance)
    });
  });

  return app;
}
