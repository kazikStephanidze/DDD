import fs from 'node:fs';
import path from 'node:path';
import { isFirebaseConfigured, rtdbGet, rtdbPatch } from './firebaseDb';
import {
  applyRuntimeSnapshot,
  clearRuntimeDirty,
  collectRuntimeSnapshot,
  isRuntimeDirty,
  isServerlessRuntime
} from './runtimeRegistry';

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
  | 'dicepoker'
  | 'bjtable';

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
  usedQuoteHashes: string[];
  usedHoroscopeHashes: string[];
  loans?: LoanRecord[];
  loanRequests?: LoanRequest[];
  uniqueTalismans?: Record<string, UniqueTalismanOwner>;
  lottery?: ChatLotteryState;
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
let lastSavedChatsHash = '';
let lastSavedLogsHash = '';
let lastSavedRuntimeHash = '';
let dbDirty = false;

interface FirebaseStoredState {
  meta?: {
    timezone?: string;
    telegramToken?: string;
    trackedBotMessages?: TrackedBotMessage[];
  };
  chats?: Record<string, ChatState>;
  logs?: BotLogEntry[];
  runtime?: Record<string, unknown>;
}

function ensureDataDir() {
  if (isServerlessRuntime()) return;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function normalizeDbSchema(target: DatabaseSchema): void {
  ensureSimulatorSeedOn(target);
  for (const chat of Object.values(target.chats)) {
    if (!chat.loans) chat.loans = [];
    if (!chat.loanRequests) chat.loanRequests = [];
    if (!chat.uniqueTalismans) chat.uniqueTalismans = {};
    if (!chat.usedPhraseKeys) chat.usedPhraseKeys = [];
    if (!chat.usedQuoteHashes) chat.usedQuoteHashes = [];
    if (!chat.usedHoroscopeHashes) chat.usedHoroscopeHashes = [];
    if (!chat.lottery) chat.lottery = { date: '', tickets: [], lastDrawnDate: '' };
    if (!chat.lottery.tickets) chat.lottery.tickets = [];
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
  if (!target.trackedBotMessages) target.trackedBotMessages = [];
}

function computeHashes(): { meta: string; chats: string; logs: string; runtime: string } {
  const metaObj = {
    timezone: db.timezone,
    telegramToken: db.telegramToken || null,
    trackedBotMessages: db.trackedBotMessages || []
  };
  return {
    meta: JSON.stringify(metaObj),
    chats: JSON.stringify(db.chats),
    logs: JSON.stringify(logs.slice(0, 80)),
    runtime: JSON.stringify(collectRuntimeSnapshot())
  };
}

function updateSavedHashes(): void {
  const h = computeHashes();
  lastSavedMetaHash = h.meta;
  lastSavedChatsHash = h.chats;
  lastSavedLogsHash = h.logs;
  lastSavedRuntimeHash = h.runtime;
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
}): Promise<DatabaseSchema> {
  if (!firebaseInitialized && !isServerlessRuntime()) {
    loadDatabase();
  }

  if (!isFirebaseConfigured()) {
    normalizeDbSchema(db);
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

  try {
    const remote = await rtdbGet<FirebaseStoredState>('depBot');
    lastFirebaseLoadAt = Date.now();
    lastFirebaseSyncAt = lastFirebaseLoadAt;
    lastFirebaseError = null;

    if (remote && remote.chats && Object.keys(remote.chats).length > 0) {
      const envToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim() || undefined;
      db = {
        chats: remote.chats || {},
        timezone: remote.meta?.timezone || process.env.BOT_TIMEZONE || 'Europe/Minsk',
        telegramToken: envToken || remote.meta?.telegramToken || db.telegramToken,
        trackedBotMessages: remote.meta?.trackedBotMessages || []
      };
      normalizeDbSchema(db);

      if (Array.isArray(remote.logs)) {
        logs = remote.logs.slice(0, 80);
      }
      if (remote.runtime) {
        applyRuntimeSnapshot(remote.runtime);
      }
      updateSavedHashes();
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
    normalizeDbSchema(db);
    firebaseInitialized = true;
  }
  return db;
}

export async function flushDatabaseToFirebase(force = false): Promise<void> {
  if (!isFirebaseConfigured()) {
    dbDirty = false;
    clearRuntimeDirty();
    return;
  }

  const hashes = computeHashes();
  const patch: Record<string, unknown> = {};

  if (force || hashes.meta !== lastSavedMetaHash) {
    patch.meta = {
      timezone: db.timezone,
      telegramToken: db.telegramToken || null,
      trackedBotMessages: db.trackedBotMessages || []
    };
  }
  if (force || hashes.chats !== lastSavedChatsHash) {
    patch.chats = db.chats;
  }
  if (force || hashes.logs !== lastSavedLogsHash) {
    patch.logs = logs.slice(0, 80);
  }
  if (force || isRuntimeDirty() || hashes.runtime !== lastSavedRuntimeHash) {
    patch.runtime = collectRuntimeSnapshot();
  }

  if (Object.keys(patch).length === 0) {
    dbDirty = false;
    clearRuntimeDirty();
    return;
  }

  try {
    await rtdbPatch('depBot', patch);
    lastSavedMetaHash = hashes.meta;
    lastSavedChatsHash = hashes.chats;
    lastSavedLogsHash = hashes.logs;
    lastSavedRuntimeHash = hashes.runtime;
    lastFirebaseSyncAt = Date.now();
    lastFirebaseError = null;
    dbDirty = false;
    clearRuntimeDirty();
  } catch (err: any) {
    lastFirebaseError = err?.message || 'Ошибка записи в Firebase RTDB';
    console.error('[Firebase RTDB] Save error:', lastFirebaseError);
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
  if (!messageId || !db.trackedBotMessages) return;
  const entry = db.trackedBotMessages.find((m) => m.chatId === chatId && m.messageId === messageId);
  if (entry) {
    entry.expiresAt = Date.now() + ttlMs;
  }
}

export function trackBotMessage(chatId: string, messageId: string, ttlMs: number = BOT_MESSAGE_TTL_MS): void {
  if (!messageId) return;
  if (!db.trackedBotMessages) db.trackedBotMessages = [];
  const now = Date.now();
  db.trackedBotMessages.push({
    chatId,
    messageId,
    sentAt: now,
    expiresAt: now + ttlMs
  });
  if (db.trackedBotMessages.length > 2000) {
    db.trackedBotMessages = db.trackedBotMessages.slice(-2000);
  }
  scheduleSave();
}

export function untrackBotMessage(chatId: string, messageId: string): void {
  if (!db.trackedBotMessages) return;
  const prevLen = db.trackedBotMessages.length;
  db.trackedBotMessages = db.trackedBotMessages.filter(
    (m) => !(m.chatId === chatId && m.messageId === messageId)
  );
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
  scheduleSave();
}

export function addBotLog(entry: Omit<BotLogEntry, 'id' | 'timestamp'>) {
  logs.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    ...entry
  });
  if (logs.length > 150) {
    logs = logs.slice(0, 150);
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
