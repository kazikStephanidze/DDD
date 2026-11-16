import { Bot, InlineKeyboard as GrammyKeyboard } from 'grammy';
import {
  BotTransport,
  InlineKeyboard,
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
import { hasActiveBlitzForChat, sendChatBlitzBroadcast } from './features/blitz.js';
import {
  BLITZ_INTERVAL_MS,
  BLITZ_WINDOW_END_HOUR,
  BLITZ_WINDOW_START_HOUR,
  addBotLog,
  getDb,
  getExpiredBotMessages,
  getZonedDateTimeParts,
  refreshTrackedBotMessage,
  scheduleSave,
  trackBotMessage,
  untrackBotMessage
} from './storage.js';

import {
  isServerlessRuntime
} from './runtimeRegistry.js';

export interface TelegramBotStatus {
  running: boolean;
  hasToken: boolean;
  username: string | null;
  firstName: string | null;
  botId: number | null;
  canReadAllGroupMessages: boolean | null;
  startedAt: number | null;
  lastError: string | null;
  mode?: 'polling' | 'webhook';
  webhookUrl?: string | null;
}

let activeBot: Bot | null = null;
let webhookBot: Bot | null = null;
let webhookBotToken = '';
let lastStatusCheckAt = 0;
let status: TelegramBotStatus = {
  running: false,
  hasToken: false,
  username: null,
  firstName: null,
  botId: null,
  canReadAllGroupMessages: null,
  startedAt: null,
  lastError: null,
  mode: isServerlessRuntime() ? 'webhook' : 'polling',
  webhookUrl: null
};

function toGrammyKeyboard(kb?: InlineKeyboard): GrammyKeyboard | undefined {
  if (!kb || kb.length === 0) return undefined;
  const g = new GrammyKeyboard();
  kb.forEach((row, rIdx) => {
    row.forEach((btn) => {
      g.text(btn.text, btn.callbackData);
    });
    if (rIdx < kb.length - 1) g.row();
  });
  return g;
}

const chatRateLimitUntil = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterMs(err: any): number | null {
  const desc = String(err?.description || err?.message || '');
  const retryAfter = err?.parameters?.retry_after;
  if (err?.error_code === 429 || typeof retryAfter === 'number' || desc.includes('Too Many Requests')) {
    const sec = Number(retryAfter || 2);
    return Math.max(1000, sec * 1000 + 150);
  }
  return null;
}

function resolveTelegramToken(tokenOverride?: string): string {
  return (tokenOverride ?? process.env.TELEGRAM_BOT_TOKEN ?? getDb().telegramToken ?? '').trim();
}

export function createTelegramTransport(bot: Bot): BotTransport {
  return {
    source: 'telegram',
    getRollDelayMs: () => 2200,
    async sendMessage(chatId: string, text: string, keyboard?: InlineKeyboard): Promise<string | null> {
      const attemptSend = async (): Promise<string | null> => {
        const sent = await bot.api.sendMessage(Number(chatId), text, {
          reply_markup: toGrammyKeyboard(keyboard)
        });
        const msgId = String(sent.message_id);
        trackBotMessage(chatId, msgId);
        return msgId;
      };

      try {
        return await attemptSend();
      } catch (err: any) {
        const retryMs = getRetryAfterMs(err);
        if (retryMs !== null) {
          chatRateLimitUntil.set(chatId, Date.now() + retryMs);
          await sleep(retryMs);
          try {
            return await attemptSend();
          } catch (retryErr: any) {
            console.error('[Telegram] sendMessage retry error:', retryErr?.description || retryErr?.message);
            return null;
          }
        }
        console.error('[Telegram] sendMessage error:', err?.description || err?.message);
        return null;
      }
    },
    async editMessage(
      chatId: string,
      messageId: string,
      text: string,
      keyboard?: InlineKeyboard,
      options?: { isAnimation?: boolean }
    ): Promise<void> {
      if (options?.isAnimation && Date.now() < (chatRateLimitUntil.get(chatId) || 0)) {
        return;
      }

      const attemptEdit = async () => {
        await bot.api.editMessageText(Number(chatId), Number(messageId), text, {
          reply_markup: toGrammyKeyboard(keyboard)
        });
        refreshTrackedBotMessage(chatId, messageId);
      };

      try {
        await attemptEdit();
      } catch (err: any) {
        const retryMs = getRetryAfterMs(err);
        if (retryMs !== null) {
          chatRateLimitUntil.set(chatId, Date.now() + retryMs);
          if (options?.isAnimation) {
            return;
          }
          await sleep(retryMs);
          try {
            await attemptEdit();
          } catch (retryErr: any) {
            console.error('[Telegram] editMessage retry error:', retryErr?.description || retryErr?.message);
          }
          return;
        }
        const desc = String(err?.description || err?.message || '');
        if (
          !desc.includes('message is not modified') &&
          !desc.includes('message to edit not found') &&
          !desc.includes('MESSAGE_ID_INVALID')
        ) {
          console.error('[Telegram] editMessage error:', desc);
        }
      }
    },
    async sendDice(chatId: string, emoji: '🎲' | '🎰' = '🎲'): Promise<{ value: number; messageId: string | null }> {
      const fallbackMax = emoji === '🎰' ? 64 : 6;
      try {
        const sent = await bot.api.sendDice(Number(chatId), emoji);
        const msgId = String(sent.message_id);
        trackBotMessage(chatId, msgId);
        return {
          value: sent.dice?.value ?? Math.floor(Math.random() * fallbackMax) + 1,
          messageId: msgId
        };
      } catch (err: any) {
        console.error('[Telegram] sendDice error:', err?.description || err?.message);
        return { value: Math.floor(Math.random() * fallbackMax) + 1, messageId: null };
      }
    },
    async deleteMessage(chatId: string, messageId: string): Promise<void> {
      if (!messageId) return;
      untrackBotMessage(chatId, messageId);
      try {
        await bot.api.deleteMessage(Number(chatId), Number(messageId));
      } catch {
        // Message already deleted or cannot be deleted
      }
    },
    async answerCallback(callbackId: string, text?: string, showAlert?: boolean): Promise<void> {
      try {
        await bot.api.answerCallbackQuery(callbackId, {
          text: text ? text.slice(0, 195) : undefined,
          show_alert: showAlert
        });
      } catch {
        // Ignore expired callback queries
      }
    }
  };
}

function attachBotHandlers(bot: Bot, transport: BotTransport): void {
  bot.command(['start', 'menu', 'top', 'me'], async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const chatType =
      ctx.chat.type === 'private'
        ? 'private'
        : ctx.chat.type === 'supergroup'
          ? 'supergroup'
          : 'group';
    const title = 'title' in ctx.chat && ctx.chat.title ? ctx.chat.title : ctx.from.first_name;
    const rawCmd = (ctx.message?.text || '/start').trim().split(/\s+/)[0];

    await handleCommand(
      transport,
      { chatId: String(ctx.chat.id), title, type: chatType },
      {
        userId: String(ctx.from.id),
        firstName: ctx.from.first_name,
        username: ctx.from.username
      },
      rawCmd
    );
  });

  bot.on('callback_query:data', async (ctx) => {
    const msg = ctx.callbackQuery.message;
    if (!msg || !ctx.from) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const chat = msg.chat;
    const chatType =
      chat.type === 'private' ? 'private' : chat.type === 'supergroup' ? 'supergroup' : 'group';
    const title = 'title' in chat && chat.title ? chat.title : ctx.from.first_name;

    await handleCallback(
      transport,
      { chatId: String(chat.id), title, type: chatType },
      {
        userId: String(ctx.from.id),
        firstName: ctx.from.first_name,
        username: ctx.from.username
      },
      ctx.callbackQuery.id,
      String(msg.message_id),
      ctx.callbackQuery.data
    );
  });

  bot.on('message', async (ctx) => {
    if (!ctx.chat || !ctx.from || ctx.from.is_bot) return;
    const text = ctx.message.text || ctx.message.caption || '';
    if (!text || text.startsWith('/')) return;

    const chatType =
      ctx.chat.type === 'private'
        ? 'private'
        : ctx.chat.type === 'supergroup'
          ? 'supergroup'
          : 'group';
    const title = 'title' in ctx.chat && ctx.chat.title ? ctx.chat.title : ctx.from.first_name;

    await handleTextMessage(
      transport,
      { chatId: String(ctx.chat.id), title, type: chatType },
      {
        userId: String(ctx.from.id),
        firstName: ctx.from.first_name,
        username: ctx.from.username
      },
      text
    );
  });

  bot.catch((err) => {
    console.error('[Telegram] Bot middleware error:', err.message);
    status.lastError = err.message;
  });
}

async function getOrCreateWebhookBot(tokenOverride?: string): Promise<Bot | null> {
  const token = resolveTelegramToken(tokenOverride);
  if (!token) return null;
  if (webhookBot && webhookBotToken === token && webhookBot.isInited() && status.username) {
    return webhookBot;
  }
  const bot = new Bot(token);
  const transport = createTelegramTransport(bot);
  attachBotHandlers(bot, transport);
  await bot.init();
  webhookBot = bot;
  webhookBotToken = token;
  status = {
    ...status,
    running: true,
    hasToken: true,
    username: bot.botInfo.username || null,
    firstName: bot.botInfo.first_name || 'Дядя Деп',
    botId: bot.botInfo.id,
    canReadAllGroupMessages: Boolean(bot.botInfo.can_read_all_group_messages),
    startedAt: status.startedAt || Date.now(),
    lastError: null,
    mode: 'webhook'
  };
  return bot;
}

export function getTelegramStatus(): TelegramBotStatus {
  const token = resolveTelegramToken();
  return {
    ...status,
    hasToken: Boolean(token) || status.hasToken,
    mode: isServerlessRuntime() ? 'webhook' : status.mode || 'polling'
  };
}

export async function refreshServerlessTelegramStatus(): Promise<TelegramBotStatus> {
  if (!isServerlessRuntime()) return getTelegramStatus();
  const token = resolveTelegramToken();
  if (!token) {
    status = {
      running: false,
      hasToken: false,
      username: null,
      firstName: null,
      botId: null,
      canReadAllGroupMessages: null,
      startedAt: null,
      lastError: 'Токен Telegram бота не задан (TELEGRAM_BOT_TOKEN).',
      mode: 'webhook',
      webhookUrl: null
    };
    return getTelegramStatus();
  }

  const now = Date.now();
  if (
    webhookBot &&
    webhookBotToken === token &&
    webhookBot.isInited() &&
    status.username &&
    now - lastStatusCheckAt < 30_000
  ) {
    return getTelegramStatus();
  }

  try {
    const bot = await getOrCreateWebhookBot(token);
    if (bot) {
      const info = await bot.api.getWebhookInfo().catch(() => null);
      lastStatusCheckAt = now;
      status = {
        ...status,
        running: Boolean(info?.url),
        hasToken: true,
        mode: 'webhook',
        webhookUrl: info?.url || null,
        lastError: info?.last_error_message || null
      };
    }
  } catch (err: any) {
    status = {
      ...status,
      running: false,
      hasToken: true,
      mode: 'webhook',
      lastError: err?.description || err?.message || 'Ошибка Telegram API'
    };
  }
  return getTelegramStatus();
}

export function getActiveTelegramTransport(): BotTransport | null {
  if (activeBot && status.running) {
    return createTelegramTransport(activeBot);
  }
  if (webhookBot) {
    return createTelegramTransport(webhookBot);
  }
  if (isServerlessRuntime()) {
    const token = resolveTelegramToken();
    if (token) {
      return createTelegramTransport(new Bot(token));
    }
  }
  return null;
}

export async function handleTelegramWebhook(update: any): Promise<{ ok: boolean; error?: string }> {
  const token = resolveTelegramToken();
  if (!token) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' };
  }
  const bot = await getOrCreateWebhookBot(token);
  if (!bot) {
    return { ok: false, error: 'Failed to initialize Telegram bot' };
  }
  await bot.handleUpdate(update);
  return { ok: true };
}

export async function setupTelegramWebhook(
  webhookUrl: string,
  tokenOverride?: string
): Promise<TelegramBotStatus> {
  const token = resolveTelegramToken(tokenOverride);
  if (!token) {
    status = {
      ...status,
      running: false,
      hasToken: false,
      lastError: 'Токен Telegram бота не задан.'
    };
    return getTelegramStatus();
  }

  try {
    const bot = await getOrCreateWebhookBot(token);
    if (!bot) throw new Error('Не удалось инициализировать бота');

    await bot.api.setMyCommands([
      { command: 'start', description: 'Открыть стол Дяди Депа (главное меню)' },
      { command: 'menu', description: 'Меню игр и бонуса' },
      { command: 'me', description: 'Личное дело, статистика и ачивки' },
      { command: 'top', description: 'Доска позора и почета чата' }
    ]);

    await bot.api.setWebhook(webhookUrl, {
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false
    });

    lastStatusCheckAt = Date.now();
    status = {
      ...status,
      running: true,
      hasToken: true,
      mode: 'webhook',
      webhookUrl,
      lastError: null
    };

    addBotLog({
      source: 'telegram',
      chatId: 'system',
      chatTitle: 'Telegram Webhook',
      event: 'Webhook установлен',
      detail: `@${bot.botInfo.username} → ${webhookUrl}`
    });
  } catch (err: any) {
    status = {
      ...status,
      running: false,
      hasToken: true,
      mode: 'webhook',
      lastError: err?.description || err?.message || 'Ошибка установки Webhook'
    };
  }
  return getTelegramStatus();
}

export async function stopTelegramBot(): Promise<void> {
  if (activeBot) {
    try {
      await activeBot.stop();
    } catch {
      // ignore
    }
    activeBot = null;
  }
  status.running = false;
}

export async function startTelegramBot(tokenOverride?: string): Promise<TelegramBotStatus> {
  if (isServerlessRuntime()) {
    return refreshServerlessTelegramStatus();
  }

  await stopTelegramBot();

  const token = resolveTelegramToken(tokenOverride);
  if (!token) {
    status = {
      running: false,
      hasToken: false,
      username: null,
      firstName: null,
      botId: null,
      canReadAllGroupMessages: null,
      startedAt: null,
      lastError: 'Токен Telegram бота не задан.',
      mode: 'polling',
      webhookUrl: null
    };
    return getTelegramStatus();
  }

  status = {
    running: false,
    hasToken: true,
    username: null,
    firstName: null,
    botId: null,
    canReadAllGroupMessages: null,
    startedAt: null,
    lastError: null,
    mode: 'polling',
    webhookUrl: null
  };

  try {
    const bot = new Bot(token);
    const transport = createTelegramTransport(bot);

    // Fetch bot identity
    const me = await bot.api.getMe();

    await bot.api.setMyCommands([
      { command: 'start', description: 'Открыть стол Дяди Депа (главное меню)' },
      { command: 'menu', description: 'Меню игр и бонуса' },
      { command: 'me', description: 'Личное дело, статистика и ачивки' },
      { command: 'top', description: 'Доска позора и почета чата' }
    ]);

    attachBotHandlers(bot, transport);

    // Clear webhook if any existed and launch long polling
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    activeBot = bot;

    // Start polling in background (grammy's start() resolves only when stopped)
    bot.start({
      allowed_updates: ['message', 'callback_query'],
      onStart: () => {
        console.log(`[Telegram] Дядя Деп запущен как @${me.username} (${me.first_name})`);
      }
    }).catch((err) => {
      console.error('[Telegram] Polling crashed:', err?.message || err);
      status.running = false;
      status.lastError = err?.message || 'Polling stopped';
    });

    status = {
      running: true,
      hasToken: true,
      username: me.username || null,
      firstName: me.first_name || 'Дядя Деп',
      botId: me.id,
      canReadAllGroupMessages: Boolean(me.can_read_all_group_messages),
      startedAt: Date.now(),
      lastError: null,
      mode: 'polling',
      webhookUrl: null
    };

    addBotLog({
      source: 'telegram',
      chatId: 'system',
      chatTitle: 'Telegram Bot API',
      event: 'Бот подключён',
      detail: `@${me.username} (${me.first_name}) онлайн · чтение чатов: ${me.can_read_all_group_messages ? 'ДА' : 'НЕТ (Privacy ON)'}`
    });
  } catch (err: any) {
    const msg = err?.description || err?.message || 'Ошибка подключения к Telegram Bot API';
    console.error('[Telegram] Startup failed:', msg);
    status = {
      running: false,
      hasToken: true,
      username: null,
      firstName: null,
      botId: null,
      canReadAllGroupMessages: null,
      startedAt: null,
      lastError: msg,
      mode: 'polling',
      webhookUrl: null
    };
  }

  return getTelegramStatus();
}

let schedulerTimer: NodeJS.Timeout | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;
let lobbySweepTimer: NodeJS.Timeout | null = null;
let cleanupInProgress = false;
const BLITZ_COOLDOWN_TOLERANCE_MS = 10 * 60 * 1000; // 10m jitter margin for external/GitHub crons
const LAZY_CHAT_SCHEDULE_COOLDOWN_MS = 45 * 1000;
const lastLazyScheduleCheckByChat = new Map<string, number>();

async function cleanupExpiredTelegramMessages(onlyChatId?: string) {
  const tgTransport = getActiveTelegramTransport();
  if (cleanupInProgress || !tgTransport) return;
  const expiredAll = getExpiredBotMessages();
  const expired = onlyChatId
    ? expiredAll.filter((entry) => entry.chatId === onlyChatId)
    : expiredAll;
  if (expired.length === 0) return;

  cleanupInProgress = true;
  try {
    const batch = expired.slice(0, onlyChatId ? 8 : 20);
    for (const entry of batch) {
      if (entry.chatId.startsWith('sim-')) {
        untrackBotMessage(entry.chatId, entry.messageId);
        continue;
      }
      if (isProtectedInteractiveMessage(entry.messageId)) {
        refreshTrackedBotMessage(entry.chatId, entry.messageId, 120_000);
        continue;
      }
      try {
        await tgTransport.deleteMessage?.(entry.chatId, entry.messageId);
      } catch {
        // Message already deleted, older than 48h, or bot lacks delete rights in this chat
      } finally {
        untrackBotMessage(entry.chatId, entry.messageId);
      }
    }
  } finally {
    cleanupInProgress = false;
  }
}

async function runScheduledBroadcastsForSingleChat(
  chatId: string,
  options: {
    tgTransport: BotTransport | null;
    dateStr: string;
    hour: number;
    minute: number;
    now: number;
    onSimulatorBroadcast?: (type: 'horoscope' | 'leaderboard' | 'evening' | 'lottery', chatId: string) => void;
  }
): Promise<string[]> {
  const db = getDb();
  const chat = db.chats[chatId];
  if (!chat) return [];

  const ranBroadcasts: string[] = [];
  const hasPlayers = Object.keys(chat.players).length > 0;
  const { tgTransport, dateStr, hour, minute, now, onSimulatorBroadcast } = options;

  // Catch up any un-drawn yesterday/older lottery tickets regardless of current hour
  if (
    chat.lottery &&
    chat.lottery.tickets.length > 0 &&
    chat.lottery.date &&
    chat.lottery.date < dateStr &&
    chat.lottery.lastDrawnDate !== chat.lottery.date
  ) {
    const pendingDate = chat.lottery.date;
    try {
      if (chat.type === 'simulator') {
        if (onSimulatorBroadcast) onSimulatorBroadcast('lottery', chat.chatId);
        chat.lottery.lastDrawnDate = pendingDate;
        ranBroadcasts.push(`lottery:${chat.chatId}`);
      } else if (tgTransport) {
        await sendDailyLotteryDrawBroadcast(tgTransport, chat.chatId, pendingDate);
        ranBroadcasts.push(`lottery:${chat.chatId}`);
      }
    } catch (err: any) {
      console.warn(`[Scheduler] Past lottery draw error (${chat.chatId}):`, err?.message || err);
    }
  }

  // 12:00 Daily Horoscope (allow 12:00..20:59 window so serverless crons/activity never miss)
  if (hasPlayers && hour >= 12 && hour < 21 && chat.lastHoroscopeDate !== dateStr) {
    try {
      if (chat.type === 'simulator') {
        if (onSimulatorBroadcast) onSimulatorBroadcast('horoscope', chat.chatId);
        chat.lastHoroscopeDate = dateStr;
        ranBroadcasts.push(`horoscope:${chat.chatId}`);
      } else if (tgTransport) {
        await sendDailyHoroscopeBroadcast(tgTransport, chat.chatId, dateStr);
        ranBroadcasts.push(`horoscope:${chat.chatId}`);
      }
    } catch (err: any) {
      console.warn(`[Scheduler] Horoscope error (${chat.chatId}):`, err?.message || err);
    }
  }

  // 12:01 Daily Leaderboard (on local poller wait until 12:01 so Horoscope precedes it; on serverless run any time >= 12:00)
  const leaderboardWindowOpen =
    (hour === 12 && (minute >= 1 || isServerlessRuntime())) || (hour > 12 && hour < 21);
  if (hasPlayers && leaderboardWindowOpen && chat.lastLeaderboardDate !== dateStr) {
    try {
      if (chat.type === 'simulator') {
        if (onSimulatorBroadcast) onSimulatorBroadcast('leaderboard', chat.chatId);
        chat.lastLeaderboardDate = dateStr;
        ranBroadcasts.push(`leaderboard:${chat.chatId}`);
      } else if (tgTransport) {
        await sendDailyLeaderboardBroadcast(tgTransport, chat.chatId, dateStr);
        ranBroadcasts.push(`leaderboard:${chat.chatId}`);
      }
    } catch (err: any) {
      console.warn(`[Scheduler] Leaderboard error (${chat.chatId}):`, err?.message || err);
    }
  }

  // 20:55 Daily Lottery Draw (allow 20:55..23:59 window so cron jitter after 21:30 still draws tonight's pot)
  const lotteryWindowOpen = (hour === 20 && minute >= 55) || hour >= 21;
  if (
    lotteryWindowOpen &&
    chat.lottery &&
    chat.lottery.tickets.length > 0 &&
    chat.lottery.lastDrawnDate !== dateStr
  ) {
    try {
      if (chat.type === 'simulator') {
        if (onSimulatorBroadcast) onSimulatorBroadcast('lottery', chat.chatId);
        chat.lottery.lastDrawnDate = dateStr;
        ranBroadcasts.push(`lottery:${chat.chatId}`);
      } else if (tgTransport) {
        await sendDailyLotteryDrawBroadcast(tgTransport, chat.chatId, dateStr);
        ranBroadcasts.push(`lottery:${chat.chatId}`);
      }
    } catch (err: any) {
      console.warn(`[Scheduler] Lottery draw error (${chat.chatId}):`, err?.message || err);
    }
  }

  // 21:00 Evening 24h Report (allow 21:00..23:59 window)
  if (hasPlayers && hour >= 21 && chat.lastEveningReportDate !== dateStr) {
    try {
      if (chat.type === 'simulator') {
        if (onSimulatorBroadcast) onSimulatorBroadcast('evening', chat.chatId);
        chat.lastEveningReportDate = dateStr;
        ranBroadcasts.push(`evening:${chat.chatId}`);
      } else if (tgTransport) {
        await sendDailyEveningReportBroadcast(tgTransport, chat.chatId, dateStr);
        ranBroadcasts.push(`evening:${chat.chatId}`);
      }
    } catch (err: any) {
      console.warn(`[Scheduler] Evening report error (${chat.chatId}):`, err?.message || err);
    }
  }

  // Chat Blitz every ~2 hours between 10:00 and 20:00
  if (
    hasPlayers &&
    chat.type !== 'simulator' &&
    tgTransport &&
    hour >= BLITZ_WINDOW_START_HOUR &&
    hour < BLITZ_WINDOW_END_HOUR
  ) {
    const lastBlitz = chat.lastBlitzAt || 0;
    const minCooldown = BLITZ_INTERVAL_MS - BLITZ_COOLDOWN_TOLERANCE_MS;
    if (!hasActiveBlitzForChat(chat.chatId) && now - lastBlitz >= minCooldown) {
      try {
        chat.lastBlitzAt = now;
        scheduleSave();
        const sent = await sendChatBlitzBroadcast(tgTransport, chat.chatId);
        if (sent) {
          ranBroadcasts.push(`blitz:${chat.chatId}`);
        }
      } catch (err: any) {
        console.warn(`[Scheduler] Blitz error (${chat.chatId}):`, err?.message || err);
      }
    }
  }

  return ranBroadcasts;
}

/**
 * Piggybacked per-chat scheduler invoked on Telegram webhooks on serverless Vercel,
 * so active chats always receive Blitz / 12:00 / 20:55 / 21:00 without waiting for a local PC server.
 */
export async function runScheduledTasksForChat(chatId: string): Promise<string[]> {
  if (!chatId || chatId.startsWith('sim-')) return [];
  const now = Date.now();
  const prevCheck = lastLazyScheduleCheckByChat.get(chatId) || 0;
  if (now - prevCheck < LAZY_CHAT_SCHEDULE_COOLDOWN_MS) {
    return [];
  }
  lastLazyScheduleCheckByChat.set(chatId, now);

  await cleanupExpiredTelegramMessages(chatId);

  const tgTransport = getActiveTelegramTransport();
  if (!tgTransport) return [];

  const { dateStr, hour, minute } = getZonedDateTimeParts();
  return runScheduledBroadcastsForSingleChat(chatId, {
    tgTransport,
    dateStr,
    hour,
    minute,
    now
  });
}

export async function runScheduledTasksNow(
  onSimulatorBroadcast?: (type: 'horoscope' | 'leaderboard' | 'evening' | 'lottery', chatId: string) => void
): Promise<{
  dateStr: string;
  hour: number;
  minute: number;
  cleanedExpired: boolean;
  ranBroadcasts: string[];
}> {
  await cleanupExpiredTelegramMessages();
  await sweepExpiredLobbies();

  const { dateStr, hour, minute } = getZonedDateTimeParts();
  const db = getDb();
  const tgTransport = getActiveTelegramTransport();
  const now = Date.now();
  const ranBroadcasts: string[] = [];

  for (const chatId of Object.keys(db.chats)) {
    const chatRan = await runScheduledBroadcastsForSingleChat(chatId, {
      tgTransport,
      dateStr,
      hour,
      minute,
      now,
      onSimulatorBroadcast
    });
    if (chatRan.length > 0) {
      ranBroadcasts.push(...chatRan);
    }
  }

  return {
    dateStr,
    hour,
    minute,
    cleanedExpired: true,
    ranBroadcasts
  };
}

/**
 * Checks every 20 seconds whether it is 12:00 (Guidance), 12:01 (Leaderboard), 20:55 (Lottery Draw), or 21:00 (Evening 24h Summary)
 * in the configured timezone, deletes expired non-active bot messages, and sweeps idle lobbies (4 min TTL).
 */
export function startDailyScheduler(
  onSimulatorBroadcast?: (type: 'horoscope' | 'leaderboard' | 'evening' | 'lottery', chatId: string) => void
) {
  if (isServerlessRuntime()) return;
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (lobbySweepTimer) clearInterval(lobbySweepTimer);

  cleanupTimer = setInterval(() => {
    void cleanupExpiredTelegramMessages();
  }, 8_000);

  lobbySweepTimer = setInterval(() => {
    void sweepExpiredLobbies();
  }, 15_000);

  schedulerTimer = setInterval(() => {
    void runScheduledTasksNow(onSimulatorBroadcast);
  }, 20_000);
}
