import fs from 'node:fs';
import path from 'node:path';
import { isFirebaseConfigured, rtdbGet, rtdbPatch, rtdbPut } from './firebaseDb.js';
import {
  applyRuntimeSnapshot,
  clearRuntimeDirty,
  collectRuntimeEntries,
  isServerlessRuntime
} from './runtimeRegistry.js';

export type GameType =
  | 'roulette'
  | 'crash'
  | 'russian'
  | 'mines'
  | 'dice'
  | 'blackjack'
  | 'plinko'
  | 'races'
  | 'slots'
  | 'hilo'
  | 'ladder'
  | 'duel'
  | 'thimbles'
  | 'rps'
  | 'penalty'
  | 'bjtable'
  | 'battleship'
  | 'chicken'
  | 'blindauc'
  | 'liarsdice'
  | 'hotpotato'
  | 'scratch';

export type TalismanRarity = 'common' | 'rare' | 'epic' | 'legendary' | 'unique';

export interface OwnedTalisman {
  instanceId: string;
  talismanId: string;
  obtainedAt: number;
}

export interface DailyBaseline {
  gamesPlayed: number;
  totalWon: number;
  totalLost: number;
  casesOpened: number;
  balance: number;
  sinceAt: number;
}

export interface TrackedBotMessage {
  chatId: string;
  messageId: string;
  sentAt: number;
  expiresAt?: number;
}

export interface PlayerStats {
  totalLost: number;
  totalWon: number;
  gamesPlayed: number;
  winsCount?: number;
  biggestWin?: number;
  gameCounts?: Record<string, number>;
  maxCrashMultiplier: number;
  lastDodepWins: number;
  ghostCount?: number;
  allInCount?: number;
  zeroBonusCount?: number;
  casesOpened?: number;
  talismansRecycledValue?: number;
  craftsDone?: number;
}

export type DailyQuestKind =
  | 'play_any'
  | 'win_any'
  | 'crash_x2'
  | 'allin_or_dodep'
  | 'case_or_craft'
  | 'table_games'
  | 'skill_streak'
  | 'social_pot_lot';

export interface DailyQuestItem {
  id: DailyQuestKind;
  title: string;
  progress: number;
  target: number;
  done: boolean;
}

export interface PlayerDailyQuests {
  date: string; // YYYY-MM-DD
  quests: DailyQuestItem[];
  rewardClaimed: boolean;
}

export interface LotteryTicket {
  userId: string;
  firstName: string;
  ticketNum: number;
  boughtAt: number;
}

export interface ChatLotteryState {
  date: string;
  tickets: LotteryTicket[];
  lastDrawnDate?: string;
}

export interface DailyHoroscope {
  date: string; // YYYY-MM-DD in bot timezone
  text: string;
  luckyX: string;
  luckyGame: string;
}

export interface LoanRecord {
  id: string;
  chatId: string;
  lenderId: string;
  lenderName: string;
  borrowerId: string;
  borrowerName: string;
  principal: number;
  repayAmount: number;
  interestPct: number;
  paidAmount: number;
  createdAt: number;
  dueAt: number;
  lastRemindedAt: number;
  status: 'active' | 'repaid' | 'forgiven';
}

export interface LoanRequest {
  id: string;
  chatId: string;
  borrowerId: string;
  borrowerName: string;
  principal: number;
  repayAmount: number;
  interestPct: number;
  createdAt: number;
  status: 'open' | 'filled' | 'cancelled';
  messageId: string | null;
}

export interface PlayerState {
  userId: string;
  username?: string;
  firstName: string;
  balance: number;
  lastZeroBonusAt: number;
  lastLoanGivenAt?: number;
  ghostUntil: number;
  lastBetAmount: number;
  lastGameType: GameType | null;
  lastActionWasLoss: boolean;
  lastActionWasLastDodep: boolean;
  stats: PlayerStats;
  dailyHoroscope: DailyHoroscope | null;
  talismans?: OwnedTalisman[];
  equippedTalismanId?: string | null;
  talismanIncomeAccrued?: number;
  lastTalismanIncomeAt?: number;
  dailyBaseline?: DailyBaseline;
  dailyQuests?: PlayerDailyQuests | null;
  achievements?: string[];
}

export interface UniqueTalismanOwner {
  ownerId: string;
  ownerName: string;
  obtainedAt: number;
}

export interface ChatState {
  chatId: string;
  title: string;
  type: 'private' | 'group' | 'supergroup' | 'simulator';
  createdAt: number;
  lastAutoChatReplyAt: number;
  lastHoroscopeDate: string;
  lastLeaderboardDate: string;
  lastEveningReportDate?: string;
  lastBlitzAt?: number;
  usedPhraseKeys?: string[];
  usedPhraseCount?: number;
  usedQuoteHashes: string[];
  usedHoroscopeHashes: string[];
  loans?: LoanRecord[];
  loanRequests?: LoanRequest[];
  uniqueTalismans?: Record<string, UniqueTalismanOwner>;
  lottery?: ChatLotteryState;
  crashHistory?: number[];
  players: Record<string, PlayerState>;
}

export interface BotLogEntry {
  id: string;
  timestamp: number;
  source: 'telegram' | 'simulator' | 'scheduler';
  chatId: string;
  chatTitle: string;
  userName?: string;
  event: string;
  detail: string;
}

export interface DatabaseSchema {
  chats: Record<string, ChatState>;
  timezone: string;
  telegramToken?: string;
  localPollingPaused?: boolean;
  trackedBotMessages?: TrackedBotMessage[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'dep-bot-db.json');

export const STARTING_BALANCE = 1000;
export const ZERO_BONUS_AMOUNT = 350;
export const ZERO_BONUS_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
export const BOT_MESSAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes auto-delete
export const GHOST_DURATION_MS = 3 * 60 * 1000; // 3 minutes
export const CHAT_TRIGGER_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
export const CHAT_TRIGGER_PROBABILITY = 1.0; // 100%
export const LOAN_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours before overdue
export const LOAN_REMIND_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_ACTIVE_LOANS_PER_BORROWER = 2;
export const MAX_TOTAL_DEBT_PER_BORROWER = 1500;
export const MIN_GAMES_FOR_LOANS = 3;
export const LOBBY_IDLE_TTL_MS = 4 * 60 * 1000; // 4 minutes lobby timeout auto-refund
export const LOTTERY_TICKET_PRICE = 100;
export const DAILY_QUEST_REWARD_COINS = 300;
export const BLITZ_INTERVAL_MS = 2 * 60 * 60 * 1000; // every ~2 hours
export const BLITZ_WINDOW_START_HOUR = 10;
export const BLITZ_WINDOW_END_HOUR = 20;

let db: DatabaseSchema = {
  chats: {},
  timezone: process.env.BOT_TIMEZONE || 'Europe/Minsk',
  trackedBotMessages: []
};

let logs: BotLogEntry[] = [];
let saveTimer: NodeJS.Timeout | null = null;
let firebaseInitialized = false;
let lastFirebaseLoadAt = 0;
let lastFirebaseSyncAt: number | null = null;
let lastFirebaseError: string | null = null;
let lastSavedMetaHash = '';
const lastSavedRuntimeAdapterHashes = new Map<string, string>();
const lastSavedChatHashes = new Map<string, string>();
const lastSavedPhraseArchiveHashes = new Map<string, string>();
let pendingLogsToArchive: BotLogEntry[] = [];
let dbDirty = false;
const inFlightLoads = new Map<string, Promise<DatabaseSchema>>();
const processedUpdateIds = new Map<number, number>();
const UPDATE_DEDUP_TTL_MS = 15 * 60 * 1000;
const TRACKED_MESSAGE_MAX_AGE_MS = 46 * 60 * 60 * 1000; // 46h (safely within Telegram 48h delete limit)
const dirtyTrackedKeys = new Set<string>();
const deletedTrackedKeys = new Set<string>();
let clearLegacyMetaTracked = false;

interface FirebaseStoredMeta {
  timezone?: string;
  telegramToken?: string | null;
  localPollingPaused?: boolean;
  trackedBotMessages?: TrackedBotMessage[];
}

interface FirebasePhraseArchive {
  usedPhraseKeys?: string[];
  usedQuoteHashes?: string[];
  usedHoroscopeHashes?: string[];
}

interface FirebaseStoredState {
  meta?: FirebaseStoredMeta;
  chats?: Record<string, ChatState>;
  logs?: BotLogEntry[];
  logsArchive?: Record<string, BotLogEntry>;
  phraseArchive?: Record<string, FirebasePhraseArchive>;
  runtime?: Record<string, unknown>;
}

function toRtdbKey(raw: string): string {
  return raw.replace(/[.$#[\]/]/g, '_');
}

function stripChatPhrases(chat: ChatState): ChatState {
  const {
    usedPhraseKeys,
    usedQuoteHashes: _uqh,
    usedHoroscopeHashes: _uhh,
    ...hot
  } = chat;
  return {
    ...hot,
    usedPhraseCount: Math.max(chat.usedPhraseCount || 0, Array.isArray(usedPhraseKeys) ? usedPhraseKeys.length : 0),
    usedQuoteHashes: [],
    usedHoroscopeHashes: []
  };
}

function extractChatPhraseArchive(chat: ChatState): FirebasePhraseArchive {
  return {
    usedPhraseKeys: chat.usedPhraseKeys || [],
    usedQuoteHashes: chat.usedQuoteHashes || [],
    usedHoroscopeHashes: chat.usedHoroscopeHashes || []
  };
}

function ensureDataDir() {
  if (isServerlessRuntime()) return;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function normalizeSingleChat(chat: ChatState): void {
  if (!chat.loans) chat.loans = [];
  if (!chat.loanRequests) chat.loanRequests = [];
  if (!chat.uniqueTalismans) chat.uniqueTalismans = {};
  if (!chat.usedPhraseKeys) chat.usedPhraseKeys = [];
  if (chat.usedPhraseCount === undefined) {
    chat.usedPhraseCount = chat.usedPhraseKeys.length;
  } else if (chat.usedPhraseKeys.length > chat.usedPhraseCount) {
    chat.usedPhraseCount = chat.usedPhraseKeys.length;
  }
  if (!chat.usedQuoteHashes) chat.usedQuoteHashes = [];
  if (!chat.usedHoroscopeHashes) chat.usedHoroscopeHashes = [];
  if (!chat.lottery) chat.lottery = { date: '', tickets: [], lastDrawnDate: '' };
  if (!chat.lottery.tickets) chat.lottery.tickets = [];
  if (!Array.isArray(chat.crashHistory)) chat.crashHistory = [];
  if (chat.lastEveningReportDate === undefined) chat.lastEveningReportDate = '';
  if (chat.lastBlitzAt === undefined) chat.lastBlitzAt = 0;
  if (!chat.players) chat.players = {};
  for (const p of Object.values(chat.players)) {
    if (!p.talismans) p.talismans = [];
    if (p.equippedTalismanId === undefined) p.equippedTalismanId = null;
    if (p.talismanIncomeAccrued === undefined) p.talismanIncomeAccrued = 0;
    if (p.lastTalismanIncomeAt === undefined) p.lastTalismanIncomeAt = Date.now();
    if (!p.stats) {
      p.stats = {
        totalLost: 0,
        totalWon: 0,
        gamesPlayed: 0,
        maxCrashMultiplier: 0,
        lastDodepWins: 0
      };
    }
    if (!p.dailyBaseline) {
      p.dailyBaseline = createBaselineFromPlayer(p);
    }
    if (!p.achievements) p.achievements = [];
    if (p.dailyQuests === undefined) p.dailyQuests = null;
    if (!p.stats.gameCounts) p.stats.gameCounts = {};
  }
}

function normalizeDbSchema(target: DatabaseSchema, onlyChatId?: string): void {
  if (!onlyChatId || onlyChatId === 'sim-chat-1') {
    ensureSimulatorSeedOn(target);
  }
  if (onlyChatId) {
    if (target.chats[onlyChatId]) {
      normalizeSingleChat(target.chats[onlyChatId]);
    }
  } else {
    for (const chat of Object.values(target.chats)) {
      normalizeSingleChat(chat);
    }
  }
  if (!target.trackedBotMessages) target.trackedBotMessages = [];
}

function trackedMsgKey(chatId: string, messageId: string): string {
  return `${toRtdbKey(chatId)}_${toRtdbKey(messageId)}`;
}

function pruneTrackedMessagesInMemory(now = Date.now(), maxKeep = 400): void {
  if (!db.trackedBotMessages || db.trackedBotMessages.length === 0) return;
  const active = db.trackedBotMessages.filter((m) => {
    const exp = m.expiresAt ?? m.sentAt + BOT_MESSAGE_TTL_MS;
    const isTooOld = now - m.sentAt >= TRACKED_MESSAGE_MAX_AGE_MS || now - exp >= TRACKED_MESSAGE_MAX_AGE_MS;
    if (isTooOld && !m.chatId.startsWith('sim-')) {
      deletedTrackedKeys.add(trackedMsgKey(m.chatId, m.messageId));
    }
    return !isTooOld;
  });
  db.trackedBotMessages = active.length > maxKeep ? active.slice(-maxKeep) : active;
}

function mergeRemoteTrackedMessages(
  remoteMap: Record<string, TrackedBotMessage> | null | undefined,
  legacyList: TrackedBotMessage[] | null | undefined
): void {
  const now = Date.now();
  const byKey = new Map<string, TrackedBotMessage>();
  const remoteKeys = new Set<string>();

  if (remoteMap && typeof remoteMap === 'object') {
    for (const [k, item] of Object.entries(remoteMap)) {
      if (!item || !item.chatId || !item.messageId) continue;
      const exp = item.expiresAt ?? item.sentAt + BOT_MESSAGE_TTL_MS;
      if (now - item.sentAt >= TRACKED_MESSAGE_MAX_AGE_MS || now - exp >= TRACKED_MESSAGE_MAX_AGE_MS) {
        deletedTrackedKeys.add(k);
        continue;
      }
      remoteKeys.add(k);
      byKey.set(k, item);
    }
  }

  if (Array.isArray(legacyList) && legacyList.length > 0) {
    clearLegacyMetaTracked = true;
    for (const item of legacyList) {
      if (!item || !item.chatId || !item.messageId || item.chatId.startsWith('sim-')) continue;
      const exp = item.expiresAt ?? item.sentAt + BOT_MESSAGE_TTL_MS;
      if (now - item.sentAt >= TRACKED_MESSAGE_MAX_AGE_MS || now - exp >= TRACKED_MESSAGE_MAX_AGE_MS) continue;
      const k = trackedMsgKey(item.chatId, item.messageId);
      const prev = byKey.get(k);
      if (!prev || (item.expiresAt ?? 0) > (prev.expiresAt ?? 0)) {
        byKey.set(k, item);
      }
      if (!remoteKeys.has(k)) {
        dirtyTrackedKeys.add(k);
      }
    }
  }

  db.trackedBotMessages = Array.from(byKey.values()).slice(-400);
}

function computeMetaHash(): string {
  return JSON.stringify({
    timezone: db.timezone,
    telegramToken: db.telegramToken || null,
    localPollingPaused: Boolean(db.localPollingPaused)
  });
}

function updateSavedHashes(options?: { targetChatId?: string; markPhraseArchive?: boolean }): void {
  lastSavedMetaHash = computeMetaHash();
  for (const [key, val] of collectRuntimeEntries()) {
    lastSavedRuntimeAdapterHashes.set(key, JSON.stringify(val));
  }
  const chats = options?.targetChatId
    ? [db.chats[options.targetChatId]].filter(Boolean)
    : Object.values(db.chats);
  for (const c of chats) {
    lastSavedChatHashes.set(c.chatId, JSON.stringify(stripChatPhrases(c)));
    if (options?.markPhraseArchive) {
      lastSavedPhraseArchiveHashes.set(c.chatId, JSON.stringify(extractChatPhraseArchive(c)));
    }
  }
}

export function loadDatabase(): DatabaseSchema {
  const envToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim() || undefined;
  if (!isServerlessRuntime()) {
    ensureDataDir();
    if (fs.existsSync(DB_PATH)) {
      try {
        const raw = fs.readFileSync(DB_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<DatabaseSchema>;
        db = {
          chats: parsed.chats || {},
          timezone: parsed.timezone || process.env.BOT_TIMEZONE || 'Europe/Minsk',
          telegramToken: envToken || parsed.telegramToken,
          localPollingPaused: Boolean(parsed.localPollingPaused),
          trackedBotMessages: parsed.trackedBotMessages || []
        };
      } catch (err) {
        console.error('[Storage] Failed to parse local DB, starting fresh:', err);
        db.telegramToken = envToken;
      }
    } else {
      db.telegramToken = envToken;
    }
  } else {
    db.telegramToken = envToken || db.telegramToken;
  }
  normalizeDbSchema(db);
  return db;
}

export async function ensureDatabaseLoaded(options?: {
  forceRemote?: boolean;
  minIntervalMs?: number;
  targetChatId?: string;
  includePhraseArchive?: boolean;
  includeLogs?: boolean;
}): Promise<DatabaseSchema> {
  if (!firebaseInitialized && !isServerlessRuntime()) {
    loadDatabase();
  }

  if (!isFirebaseConfigured()) {
    normalizeDbSchema(db, options?.targetChatId);
    firebaseInitialized = true;
    return db;
  }

  const now = Date.now();
  const minInterval = options?.minIntervalMs ?? 0;
  if (
    firebaseInitialized &&
    !options?.forceRemote &&
    minInterval > 0 &&
    now - lastFirebaseLoadAt < minInterval
  ) {
    return db;
  }

  const scopeKey = options?.targetChatId
    ? `chat:${options.targetChatId}:${options.includePhraseArchive !== false ? 1 : 0}`
    : `full:${options?.includePhraseArchive ? 1 : 0}:${options?.includeLogs !== false ? 1 : 0}`;
  const existingFlight = inFlightLoads.get(scopeKey);
  if (existingFlight) {
    return existingFlight;
  }

  const promise = (async () => {
    try {
      const envToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim() || undefined;

      if (options?.targetChatId) {
        // Hot per-chat targeted load (skips other chats and archival logs)
        const targetId = options.targetChatId;
        const chatKey = toRtdbKey(targetId);
        const wantArchive = options.includePhraseArchive !== false;
        const wantTracked = !targetId.startsWith('sim-');

        const [meta, remoteChat, remoteArchive, remoteRuntime, remoteTracked] = await Promise.all([
          rtdbGet<FirebaseStoredMeta>('depBot/meta'),
          rtdbGet<ChatState>(`depBot/chats/${chatKey}`),
          wantArchive ? rtdbGet<FirebasePhraseArchive>(`depBot/phraseArchive/${chatKey}`) : Promise.resolve(null),
          rtdbGet<Record<string, unknown>>('depBot/runtime'),
          wantTracked ? rtdbGet<Record<string, TrackedBotMessage>>('depBot/trackedMessages') : Promise.resolve(null)
        ]);

        lastFirebaseLoadAt = Date.now();
        lastFirebaseSyncAt = lastFirebaseLoadAt;
        lastFirebaseError = null;

        if (meta) {
          db.timezone = meta.timezone || process.env.BOT_TIMEZONE || 'Europe/Minsk';
          db.telegramToken = envToken || meta.telegramToken || db.telegramToken;
          db.localPollingPaused = Boolean(meta.localPollingPaused);
        } else {
          db.telegramToken = envToken || db.telegramToken;
        }
        if (wantTracked) {
          mergeRemoteTrackedMessages(remoteTracked, meta?.trackedBotMessages);
        }

        if (remoteChat) {
          if (remoteArchive) {
            remoteChat.usedPhraseKeys = remoteArchive.usedPhraseKeys || [];
            remoteChat.usedQuoteHashes = remoteArchive.usedQuoteHashes || [];
            remoteChat.usedHoroscopeHashes = remoteArchive.usedHoroscopeHashes || [];
          } else if (!remoteChat.usedPhraseKeys && db.chats[targetId]?.usedPhraseKeys) {
            remoteChat.usedPhraseKeys = db.chats[targetId].usedPhraseKeys;
            remoteChat.usedQuoteHashes = db.chats[targetId].usedQuoteHashes || [];
            remoteChat.usedHoroscopeHashes = db.chats[targetId].usedHoroscopeHashes || [];
          }
          db.chats[targetId] = remoteChat;
          normalizeDbSchema(db, targetId);
          applyRuntimeSnapshot(remoteRuntime);
        } else if (meta) {
          // Brand-new chat not yet in Firebase; keep existing or create lazily on command
          normalizeDbSchema(db, targetId);
          applyRuntimeSnapshot(remoteRuntime);
        } else {
          // Completely empty DB in Firebase — seed once
          normalizeDbSchema(db);
          firebaseInitialized = true;
          await flushDatabaseToFirebase(true);
        }

        updateSavedHashes({ targetChatId: targetId, markPhraseArchive: wantArchive });
        dbDirty = false;
        clearRuntimeDirty();
        firebaseInitialized = true;
        return db;
      }

      // Full load (UI status, cron broadcasts, startup)
      const wantLogs = options?.includeLogs !== false;
      const wantAllArchives = Boolean(options?.includePhraseArchive);

      const [meta, remoteChats, remoteRuntime, remoteLogsArchive, remoteAllArchives, remoteTracked] =
        await Promise.all([
          rtdbGet<FirebaseStoredMeta>('depBot/meta'),
          rtdbGet<Record<string, ChatState>>('depBot/chats'),
          rtdbGet<Record<string, unknown>>('depBot/runtime'),
          wantLogs ? rtdbGet<Record<string, BotLogEntry>>('depBot/logsArchive') : Promise.resolve(null),
          wantAllArchives
            ? rtdbGet<Record<string, FirebasePhraseArchive>>('depBot/phraseArchive')
            : Promise.resolve(null),
          rtdbGet<Record<string, TrackedBotMessage>>('depBot/trackedMessages')
        ]);

      lastFirebaseLoadAt = Date.now();
      lastFirebaseSyncAt = lastFirebaseLoadAt;
      lastFirebaseError = null;

      if (remoteChats && Object.keys(remoteChats).length > 0) {
        const mergedChats: Record<string, ChatState> = {};
        for (const [key, chatObj] of Object.entries(remoteChats)) {
          if (!chatObj) continue;
          const chatId = chatObj.chatId || key;
          const archive = remoteAllArchives?.[key] || remoteAllArchives?.[toRtdbKey(chatId)];
          if (archive) {
            chatObj.usedPhraseKeys = archive.usedPhraseKeys || [];
            chatObj.usedQuoteHashes = archive.usedQuoteHashes || [];
            chatObj.usedHoroscopeHashes = archive.usedHoroscopeHashes || [];
          } else if (!chatObj.usedPhraseKeys && db.chats[chatId]?.usedPhraseKeys) {
            chatObj.usedPhraseKeys = db.chats[chatId].usedPhraseKeys;
            chatObj.usedQuoteHashes = db.chats[chatId].usedQuoteHashes || [];
            chatObj.usedHoroscopeHashes = db.chats[chatId].usedHoroscopeHashes || [];
          }
          mergedChats[chatId] = chatObj;
        }

        db = {
          chats: mergedChats,
          timezone: meta?.timezone || process.env.BOT_TIMEZONE || 'Europe/Minsk',
          telegramToken: envToken || meta?.telegramToken || db.telegramToken,
          localPollingPaused: Boolean(meta?.localPollingPaused),
          trackedBotMessages: []
        };
        mergeRemoteTrackedMessages(remoteTracked, meta?.trackedBotMessages);
        normalizeDbSchema(db);

        if (wantLogs) {
          if (remoteLogsArchive && typeof remoteLogsArchive === 'object') {
            logs = Object.values(remoteLogsArchive)
              .filter((item): item is BotLogEntry => Boolean(item && typeof item.timestamp === 'number'))
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, 80);
          } else {
            const legacyLogs = await rtdbGet<BotLogEntry[]>('depBot/logs').catch(() => null);
            if (Array.isArray(legacyLogs)) {
              logs = legacyLogs.slice(0, 80);
            }
          }
        }

        applyRuntimeSnapshot(remoteRuntime);
        updateSavedHashes({ markPhraseArchive: wantAllArchives });
        dbDirty = false;
        clearRuntimeDirty();
      } else {
        // First-time seed into Firebase RTDB from local DB or fresh simulator seed
        normalizeDbSchema(db);
        firebaseInitialized = true;
        await flushDatabaseToFirebase(true);
      }
      firebaseInitialized = true;
    } catch (err: any) {
      lastFirebaseError = err?.message || 'Ошибка чтения Firebase RTDB';
      console.error('[Firebase RTDB] Load error:', lastFirebaseError);
      normalizeDbSchema(db, options?.targetChatId);
      firebaseInitialized = true;
    } finally {
      inFlightLoads.delete(scopeKey);
    }
    return db;
  })();

  inFlightLoads.set(scopeKey, promise);
  return promise;
}

export async function flushDatabaseToFirebase(force = false, targetChatId?: string): Promise<void> {
  if (!isFirebaseConfigured()) {
    dbDirty = false;
    pendingLogsToArchive = [];
    clearRuntimeDirty();
    return;
  }
  if (!firebaseInitialized && !force) {
    return;
  }

  const metaHash = computeMetaHash();
  const patch: Record<string, unknown> = {};

  if (force || metaHash !== lastSavedMetaHash) {
    patch['meta/timezone'] = db.timezone;
    patch['meta/localPollingPaused'] = Boolean(db.localPollingPaused);
    if (db.telegramToken && db.telegramToken.trim().length > 0) {
      patch['meta/telegramToken'] = db.telegramToken.trim();
    }
  }
  if (clearLegacyMetaTracked) {
    patch['meta/trackedBotMessages'] = null;
  }

  // Atomic per-message trackedMessages delta sync (never overwrites concurrent webhooks)
  const trackedByKey = new Map<string, TrackedBotMessage>();
  for (const m of db.trackedBotMessages || []) {
    if (!m.chatId.startsWith('sim-')) {
      trackedByKey.set(trackedMsgKey(m.chatId, m.messageId), m);
    }
  }
  const flushedDirtyTracked: string[] = [];
  const flushedDeletedTracked: string[] = [];
  if (force) {
    for (const [k, m] of trackedByKey.entries()) {
      patch[`trackedMessages/${k}`] = m;
      flushedDirtyTracked.push(k);
    }
  } else {
    for (const k of dirtyTrackedKeys) {
      const m = trackedByKey.get(k);
      if (m) {
        patch[`trackedMessages/${k}`] = m;
        flushedDirtyTracked.push(k);
      }
    }
  }
  for (const k of deletedTrackedKeys) {
    if (!trackedByKey.has(k)) {
      patch[`trackedMessages/${k}`] = null;
      flushedDeletedTracked.push(k);
    }
  }

  // Per-chat delta sync: only write chats whose hot state or phrase archive actually changed
  const chatsToCheck = targetChatId
    ? [db.chats[targetChatId]].filter(Boolean)
    : Object.values(db.chats);

  const pendingChatHashes = new Map<string, string>();
  const pendingArchiveHashes = new Map<string, string>();

  for (const chat of chatsToCheck) {
    const key = toRtdbKey(chat.chatId);
    const hotChat = stripChatPhrases(chat);
    const hotHash = JSON.stringify(hotChat);
    if (force || hotHash !== lastSavedChatHashes.get(chat.chatId)) {
      patch[`chats/${key}`] = hotChat;
      pendingChatHashes.set(chat.chatId, hotHash);
    }

    const archiveObj = extractChatPhraseArchive(chat);
    const hasArchiveData =
      (archiveObj.usedPhraseKeys?.length || 0) > 0 ||
      (archiveObj.usedQuoteHashes?.length || 0) > 0 ||
      (archiveObj.usedHoroscopeHashes?.length || 0) > 0;
    if (hasArchiveData) {
      const archiveHash = JSON.stringify(archiveObj);
      if (force || archiveHash !== lastSavedPhraseArchiveHashes.get(chat.chatId)) {
        patch[`phraseArchive/${key}`] = archiveObj;
        pendingArchiveHashes.set(chat.chatId, archiveHash);
      }
    }
  }

  // Archival logs: append only newly emitted logs without reading or overwriting existing archive
  const logsToFlush = force && pendingLogsToArchive.length === 0 ? logs.slice(0, 40) : pendingLogsToArchive;
  for (const entry of logsToFlush) {
    const logKey = toRtdbKey(entry.id);
    patch[`logsArchive/${logKey}`] = entry;
  }

  // Per-adapter runtime delta sync: always compare adapter snapshots (zero network cost)
  // so any runtime Map mutation is guaranteed to flush to runtime/{adapterKey}
  const pendingRuntimeHashes = new Map<string, string>();
  for (const [adapterKey, adapterVal] of collectRuntimeEntries()) {
    const adapterHash = JSON.stringify(adapterVal);
    if (force || adapterHash !== lastSavedRuntimeAdapterHashes.get(adapterKey)) {
      patch[`runtime/${adapterKey}`] = adapterVal;
      pendingRuntimeHashes.set(adapterKey, adapterHash);
    }
  }

  if (Object.keys(patch).length === 0) {
    dbDirty = false;
    clearRuntimeDirty();
    return;
  }

  try {
    await rtdbPatch('depBot', patch);
    lastSavedMetaHash = metaHash;
    clearLegacyMetaTracked = false;
    for (const k of flushedDirtyTracked) dirtyTrackedKeys.delete(k);
    for (const k of flushedDeletedTracked) deletedTrackedKeys.delete(k);
    for (const [ak, ah] of pendingRuntimeHashes.entries()) {
      lastSavedRuntimeAdapterHashes.set(ak, ah);
    }
    for (const [cid, h] of pendingChatHashes.entries()) {
      lastSavedChatHashes.set(cid, h);
    }
    for (const [cid, h] of pendingArchiveHashes.entries()) {
      lastSavedPhraseArchiveHashes.set(cid, h);
    }
    pendingLogsToArchive = [];
    lastFirebaseSyncAt = Date.now();
    lastFirebaseError = null;
    dbDirty = false;
    clearRuntimeDirty();
  } catch (err: any) {
    lastFirebaseError = err?.message || 'Ошибка записи в Firebase RTDB';
    console.error('[Firebase RTDB] Save error:', lastFirebaseError);
  }
}

export async function claimTelegramUpdateId(updateId: number): Promise<boolean> {
  const now = Date.now();
  const cachedAt = processedUpdateIds.get(updateId);
  if (cachedAt && now - cachedAt < UPDATE_DEDUP_TTL_MS) {
    return false;
  }

  if (processedUpdateIds.size > 500) {
    for (const [id, ts] of processedUpdateIds.entries()) {
      if (now - ts >= UPDATE_DEDUP_TTL_MS || processedUpdateIds.size > 400) {
        processedUpdateIds.delete(id);
      } else {
        break;
      }
    }
  }

  if (!isFirebaseConfigured()) {
    processedUpdateIds.set(updateId, now);
    return true;
  }

  try {
    const existing = await rtdbGet<number>(`depBot/webhookDedup/${updateId}`);
    if (typeof existing === 'number' && now - existing < UPDATE_DEDUP_TTL_MS) {
      processedUpdateIds.set(updateId, existing);
      return false;
    }
    await rtdbPut(`depBot/webhookDedup/${updateId}`, now);
    processedUpdateIds.set(updateId, now);
    return true;
  } catch (err: any) {
    console.warn('[Webhook Dedup] RTDB check failed, proceeding open:', err?.message || err);
    processedUpdateIds.set(updateId, now);
    return true;
  }
}

export async function pruneFirebaseArchives(): Promise<void> {
  if (!isFirebaseConfigured()) return;
  const now = Date.now();
  try {
    const [dedupMap, logsMap] = await Promise.all([
      rtdbGet<Record<string, number>>('depBot/webhookDedup'),
      rtdbGet<Record<string, BotLogEntry>>('depBot/logsArchive')
    ]);

    const dedupPatch: Record<string, null> = {};
    if (dedupMap && typeof dedupMap === 'object') {
      for (const [id, ts] of Object.entries(dedupMap)) {
        if (typeof ts !== 'number' || now - ts > 30 * 60 * 1000) {
          dedupPatch[id] = null;
        }
      }
      if (Object.keys(dedupPatch).length > 0) {
        await rtdbPatch('depBot/webhookDedup', dedupPatch);
      }
    }

    if (logsMap && typeof logsMap === 'object') {
      const entries = Object.entries(logsMap).sort(
        (a, b) => (b[1]?.timestamp || 0) - (a[1]?.timestamp || 0)
      );
      if (entries.length > 80) {
        const logsPatch: Record<string, null> = {};
        for (const [id] of entries.slice(80)) {
          logsPatch[id] = null;
        }
        await rtdbPatch('depBot/logsArchive', logsPatch);
      }
    }

    // Prune trackedMessages older than 46 hours (Telegram refuses deletion after 48h anyway)
    const trackedMap = await rtdbGet<Record<string, TrackedBotMessage>>('depBot/trackedMessages');
    if (trackedMap && typeof trackedMap === 'object') {
      const trackedPatch: Record<string, null> = {};
      for (const [key, item] of Object.entries(trackedMap)) {
        const exp = item?.expiresAt ?? (item?.sentAt || 0) + BOT_MESSAGE_TTL_MS;
        if (
          !item ||
          now - (item.sentAt || 0) >= TRACKED_MESSAGE_MAX_AGE_MS ||
          now - exp >= TRACKED_MESSAGE_MAX_AGE_MS
        ) {
          trackedPatch[key] = null;
        }
      }
      if (Object.keys(trackedPatch).length > 0) {
        await rtdbPatch('depBot/trackedMessages', trackedPatch);
      }
    }
    pruneTrackedMessagesInMemory(now, 400);
  } catch (err: any) {
    console.warn('[Archive Prune] Skipped:', err?.message || err);
  }
}

export function getFirebaseStatus(): {
  connected: boolean;
  databaseUrl: string;
  lastSyncAt: number | null;
  lastError: string | null;
  serverless: boolean;
} {
  return {
    connected: isFirebaseConfigured() && lastFirebaseError === null,
    databaseUrl: process.env.FIREBASE_DATABASE_URL || 'https://dyadyadep-4ead0-default-rtdb.europe-west1.firebasedatabase.app',
    lastSyncAt: lastFirebaseSyncAt,
    lastError: lastFirebaseError,
    serverless: isServerlessRuntime()
  };
}

function ensureSimulatorSeedOn(target: DatabaseSchema) {
  const simId = 'sim-chat-1';
  if (!target.chats[simId]) {
    target.chats[simId] = {
      chatId: simId,
      title: 'Чат «Дядя Деп и пацаны» (Симулятор)',
      type: 'simulator',
      createdAt: Date.now(),
      lastAutoChatReplyAt: 0,
      lastHoroscopeDate: '',
      lastLeaderboardDate: '',
      lastBlitzAt: 0,
      usedPhraseKeys: [],
      usedQuoteHashes: [],
      usedHoroscopeHashes: [],
      players: {
        'sim-user-1': createDefaultPlayer('sim-user-1', 'Ты (Игрок)', 'player_one'),
        'sim-user-2': {
          ...createDefaultPlayer('sim-user-2', 'Лёха Ва-Банк', 'leha_vabank'),
          balance: 1450,
          stats: { totalLost: 650, totalWon: 1100, gamesPlayed: 9, maxCrashMultiplier: 3.45, lastDodepWins: 2 }
        },
        'sim-user-3': {
          ...createDefaultPlayer('sim-user-3', 'Димон Додепов', 'dimon_dodep'),
          balance: 400,
          stats: { totalLost: 1800, totalWon: 1200, gamesPlayed: 14, maxCrashMultiplier: 2.1, lastDodepWins: 1 }
        }
      }
    };
  }
}

export function createBaselineFromPlayer(player: {
  balance: number;
  stats: PlayerStats;
}): DailyBaseline {
  return {
    gamesPlayed: player.stats.gamesPlayed || 0,
    totalWon: player.stats.totalWon || 0,
    totalLost: player.stats.totalLost || 0,
    casesOpened: player.stats.casesOpened || 0,
    balance: player.balance,
    sinceAt: Date.now()
  };
}

export function createDefaultPlayer(userId: string, firstName: string, username?: string): PlayerState {
  const stats: PlayerStats = {
    totalLost: 0,
    totalWon: 0,
    gamesPlayed: 0,
    winsCount: 0,
    biggestWin: 0,
    gameCounts: {},
    maxCrashMultiplier: 0,
    lastDodepWins: 0,
    ghostCount: 0,
    allInCount: 0,
    zeroBonusCount: 0,
    casesOpened: 0,
    talismansRecycledValue: 0,
    craftsDone: 0
  };
  return {
    userId,
    firstName,
    username,
    balance: STARTING_BALANCE,
    lastZeroBonusAt: 0,
    lastLoanGivenAt: 0,
    ghostUntil: 0,
    lastBetAmount: 100,
    lastGameType: null,
    lastActionWasLoss: false,
    lastActionWasLastDodep: false,
    stats,
    dailyHoroscope: null,
    talismans: [],
    equippedTalismanId: null,
    talismanIncomeAccrued: 0,
    lastTalismanIncomeAt: Date.now(),
    dailyBaseline: createBaselineFromPlayer({ balance: STARTING_BALANCE, stats }),
    dailyQuests: null,
    achievements: []
  };
}

export function scheduleSave() {
  dbDirty = true;
  if (isServerlessRuntime()) {
    // In serverless mode, flushDatabaseToFirebase() runs explicitly before HTTP response finishes
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDatabaseImmediate();
  }, 350);
}

export function saveDatabaseImmediate() {
  dbDirty = true;
  if (!isServerlessRuntime()) {
    try {
      ensureDataDir();
      const tmpPath = `${DB_PATH}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf-8');
      fs.renameSync(tmpPath, DB_PATH);
    } catch (err) {
      console.error('[Storage] Save error:', err);
    }
  }
  void flushDatabaseToFirebase();
}

export function getDb(): DatabaseSchema {
  return db;
}

export function setTimezone(tz: string) {
  db.timezone = tz;
  scheduleSave();
}

export function setTelegramToken(token: string) {
  db.telegramToken = token;
  saveDatabaseImmediate();
}

export function setLocalPollingPaused(paused: boolean) {
  db.localPollingPaused = paused;
  saveDatabaseImmediate();
}

export function getOrCreateChat(
  chatId: string,
  title?: string,
  type: ChatState['type'] = 'group'
): ChatState {
  if (!db.chats[chatId]) {
    db.chats[chatId] = {
      chatId,
      title: title || `Чат ${chatId}`,
      type,
      createdAt: Date.now(),
      lastAutoChatReplyAt: 0,
      lastHoroscopeDate: '',
      lastLeaderboardDate: '',
      lastEveningReportDate: '',
      lastBlitzAt: 0,
      usedPhraseKeys: [],
      usedQuoteHashes: [],
      usedHoroscopeHashes: [],
      loans: [],
      loanRequests: [],
      uniqueTalismans: {},
      lottery: { date: '', tickets: [], lastDrawnDate: '' },
      players: {}
    };
    scheduleSave();
  } else {
    if (!db.chats[chatId].loans) db.chats[chatId].loans = [];
    if (!db.chats[chatId].loanRequests) db.chats[chatId].loanRequests = [];
    if (!db.chats[chatId].uniqueTalismans) db.chats[chatId].uniqueTalismans = {};
    if (!db.chats[chatId].lottery) db.chats[chatId].lottery = { date: '', tickets: [], lastDrawnDate: '' };
    if (db.chats[chatId].lastEveningReportDate === undefined) db.chats[chatId].lastEveningReportDate = '';
    if (db.chats[chatId].lastBlitzAt === undefined) db.chats[chatId].lastBlitzAt = 0;
    if (title && db.chats[chatId].title !== title) {
      db.chats[chatId].title = title;
      scheduleSave();
    }
  }
  return db.chats[chatId];
}

export function getOrCreatePlayer(
  chatId: string,
  userId: string,
  firstName: string,
  username?: string,
  chatTitle?: string,
  chatType: ChatState['type'] = 'group'
): { chat: ChatState; player: PlayerState; isNew: boolean } {
  const chat = getOrCreateChat(chatId, chatTitle, chatType);
  let isNew = false;
  if (!chat.players[userId]) {
    chat.players[userId] = createDefaultPlayer(userId, firstName, username);
    isNew = true;
    scheduleSave();
  } else {
    const p = chat.players[userId];
    p.firstName = firstName;
    if (username !== undefined) {
      p.username = username;
    }
    if (!p.talismans) p.talismans = [];
    if (p.equippedTalismanId === undefined) p.equippedTalismanId = null;
    if (p.talismanIncomeAccrued === undefined) p.talismanIncomeAccrued = 0;
    if (p.lastTalismanIncomeAt === undefined) p.lastTalismanIncomeAt = Date.now();
    if (!p.dailyBaseline) p.dailyBaseline = createBaselineFromPlayer(p);
    if (!p.achievements) p.achievements = [];
    if (p.dailyQuests === undefined) p.dailyQuests = null;
    if (!p.stats.gameCounts) p.stats.gameCounts = {};
  }
  return { chat, player: chat.players[userId], isNew };
}

export function refreshTrackedBotMessage(chatId: string, messageId: string, ttlMs: number = BOT_MESSAGE_TTL_MS): void {
  if (!messageId || chatId.startsWith('sim-') || !db.trackedBotMessages) return;
  const entry = db.trackedBotMessages.find((m) => m.chatId === chatId && m.messageId === messageId);
  if (entry) {
    entry.expiresAt = Date.now() + ttlMs;
    const key = trackedMsgKey(chatId, messageId);
    dirtyTrackedKeys.add(key);
    deletedTrackedKeys.delete(key);
    scheduleSave();
  }
}

export function trackBotMessage(chatId: string, messageId: string, ttlMs: number = BOT_MESSAGE_TTL_MS): void {
  if (!messageId || chatId.startsWith('sim-')) return;
  if (!db.trackedBotMessages) db.trackedBotMessages = [];
  const now = Date.now();
  const existing = db.trackedBotMessages.find((m) => m.chatId === chatId && m.messageId === messageId);
  if (existing) {
    existing.sentAt = now;
    existing.expiresAt = now + ttlMs;
  } else {
    db.trackedBotMessages.push({
      chatId,
      messageId,
      sentAt: now,
      expiresAt: now + ttlMs
    });
  }
  const key = trackedMsgKey(chatId, messageId);
  dirtyTrackedKeys.add(key);
  deletedTrackedKeys.delete(key);
  pruneTrackedMessagesInMemory(now, 400);
  scheduleSave();
}

export function untrackBotMessage(chatId: string, messageId: string): void {
  if (!db.trackedBotMessages) return;
  const prevLen = db.trackedBotMessages.length;
  db.trackedBotMessages = db.trackedBotMessages.filter(
    (m) => !(m.chatId === chatId && m.messageId === messageId)
  );
  const key = trackedMsgKey(chatId, messageId);
  deletedTrackedKeys.add(key);
  dirtyTrackedKeys.delete(key);
  if (db.trackedBotMessages.length !== prevLen) {
    scheduleSave();
  }
}

export function getExpiredBotMessages(now = Date.now()): TrackedBotMessage[] {
  if (!db.trackedBotMessages) return [];
  return db.trackedBotMessages.filter((m) => now >= (m.expiresAt ?? m.sentAt + BOT_MESSAGE_TTL_MS));
}

export function recordUsedPhraseKey(chat: ChatState, key: string) {
  if (!chat.usedPhraseKeys) chat.usedPhraseKeys = [];
  chat.usedPhraseKeys.push(key);
  if (chat.usedPhraseKeys.length > 2600) {
    chat.usedPhraseKeys = chat.usedPhraseKeys.slice(-2200);
  }
  chat.usedPhraseCount = Math.max(chat.usedPhraseCount || 0, chat.usedPhraseKeys.length);
  scheduleSave();
}

export function addBotLog(entry: Omit<BotLogEntry, 'id' | 'timestamp'>) {
  const fullEntry: BotLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    ...entry
  };
  logs.unshift(fullEntry);
  if (logs.length > 150) {
    logs = logs.slice(0, 150);
  }
  pendingLogsToArchive.push(fullEntry);
  if (pendingLogsToArchive.length > 40) {
    pendingLogsToArchive = pendingLogsToArchive.slice(-40);
  }
}

export function getBotLogs(): BotLogEntry[] {
  return logs;
}

export function getZonedDateTimeParts(timezone = db.timezone): {
  dateStr: string;
  hour: number;
  minute: number;
} {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hour = parseInt(get('hour'), 10);
    const minute = parseInt(get('minute'), 10);
    return {
      dateStr: `${year}-${month}-${day}`,
      hour: Number.isNaN(hour) ? now.getHours() : hour % 24,
      minute: Number.isNaN(minute) ? now.getMinutes() : minute
    };
  } catch {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return { dateStr: `${y}-${m}-${d}`, hour: now.getHours(), minute: now.getMinutes() };
  }
}
