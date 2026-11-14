export interface InlineButton {
  text: string;
  callbackData: string;
}

export type InlineKeyboard = InlineButton[][];

export interface SimMessage {
  id: string;
  sender: 'bot' | 'user';
  senderName: string;
  text: string;
  keyboard?: InlineKeyboard;
  timestamp: number;
  diceValue?: number;
}

export interface PlayerStats {
  totalLost: number;
  totalWon: number;
  gamesPlayed: number;
  maxCrashMultiplier: number;
  lastDodepWins: number;
  ghostCount?: number;
  allInCount?: number;
  zeroBonusCount?: number;
  casesOpened?: number;
  talismansRecycledValue?: number;
  winsCount?: number;
  biggestWin?: number;
  craftsDone?: number;
}

export interface PlayerCollectionSummary {
  count: number;
  uniqueCount: number;
  recycleTotal: number;
  score: number;
}

export interface PlayerState {
  userId: string;
  username?: string;
  firstName: string;
  balance: number;
  lastZeroBonusAt: number;
  ghostUntil: number;
  lastBetAmount: number;
  lastGameType: string | null;
  stats: PlayerStats;
  talismans?: { instanceId: string; talismanId: string; obtainedAt: number }[];
  equippedTalismanId?: string | null;
  collectionSummary?: PlayerCollectionSummary;
  dailyHoroscope: {
    date: string;
    text: string;
    luckyX: string;
    luckyGame: string;
  } | null;
}

export interface LoanRecordSummary {
  id: string;
  lenderId: string;
  lenderName: string;
  borrowerId: string;
  borrowerName: string;
  principal: number;
  repayAmount: number;
  paidAmount: number;
  interestPct: number;
  createdAt: number;
  dueAt: number;
  status: 'active' | 'repaid' | 'forgiven';
}

export interface ChatSummary {
  chatId: string;
  title: string;
  type: 'private' | 'group' | 'supergroup' | 'simulator';
  lastHoroscopeDate: string;
  lastLeaderboardDate: string;
  lastEveningReportDate?: string;
  lastAutoChatReplyAt: number;
  usedQuotesCount: number;
  lotteryTicketsCount?: number;
  players: PlayerState[];
  loans?: LoanRecordSummary[];
}

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

export interface FirebaseDbStatus {
  connected: boolean;
  databaseUrl: string;
  lastSyncAt: number | null;
  lastError: string | null;
  serverless: boolean;
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

export interface CatalogStats {
  categoriesCount: number;
  phrasesPerCategory: number;
  totalUniquePhrases: number;
  triggerKeywordsCount: number;
}

export interface SystemStatusResponse {
  telegram: TelegramBotStatus;
  firebase?: FirebaseDbStatus;
  timezone: string;
  zonedNow: { dateStr: string; hour: number; minute: number };
  catalogStats: CatalogStats;
  chats: ChatSummary[];
  logs: BotLogEntry[];
}
