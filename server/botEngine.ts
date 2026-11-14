import {
  CHAT_TRIGGER_COOLDOWN_MS,
  CHAT_TRIGGER_PROBABILITY,
  ChatState,
  GHOST_DURATION_MS,
  GameType,
  LOBBY_IDLE_TTL_MS,
  LOAN_DURATION_MS,
  LOAN_REMIND_COOLDOWN_MS,
  LoanRecord,
  LoanRequest,
  MAX_ACTIVE_LOANS_PER_BORROWER,
  MAX_TOTAL_DEBT_PER_BORROWER,
  MIN_GAMES_FOR_LOANS,
  OwnedTalisman,
  PlayerState,
  TalismanRarity,
  ZERO_BONUS_AMOUNT,
  ZERO_BONUS_COOLDOWN_MS,
  addBotLog,
  createBaselineFromPlayer,
  getDb,
  getOrCreateChat,
  getOrCreatePlayer,
  getZonedDateTimeParts,
  scheduleSave,
  trackBotMessage
} from './storage';
import {
  isServerlessRuntime,
  markRuntimeDirty,
  registerRuntimeAdapter,
  resolveRuntimeTransport
} from './runtimeRegistry';
import {
  PhraseCategory,
  findChatTriggerMatch,
  pickNonRepeatingPhrase
} from './phrases';
import {
  CASE_BY_ID,
  CASE_CATALOG,
  CaseDef,
  RARITY_META,
  TALISMAN_BY_ID,
  TALISMAN_CATALOG,
  TALISMAN_INCOME_PER_HOUR,
  TalismanDef,
  UNIQUE_TALISMANS,
  formatCaseOddsLine,
  getTalismanPotWeight,
  getTalismansByRarity,
  rollRarityForCase
} from './talismans';
import {
  BotTransport,
  GAME_RULES_SHORT,
  GAME_TITLES,
  IncomingChat,
  IncomingUser,
  InlineButton,
  InlineKeyboard,
  applyAutoDebtCollection,
  buildPostGameKeyboard,
  deductPlayerStake,
  displayName,
  formatDuration,
  getActiveLoansForBorrower,
  getActiveLoansForLender,
  getGhostRemainingMs,
  getMessageOwner,
  getPlayerActiveMenuMsgId,
  getRemainingDebt,
  getTotalRemainingDebt,
  isLoanOverdue,
  maybeSendZeroBalanceOffer,
  nextPhrase,
  playerLabel,
  sendZeroBalanceOffer,
  setMessageOwner,
  setPlayerActiveMenuMsgId,
  shortId,
  sleep
} from './engineShared';
import {
  buildProfileView,
  handleDailyQuestsCallback,
  handleProfileCallback,
  recordGameOutcome,
  recordQuestProgress,
  unlockAchievement
} from './features/profileQuests';
import { handleLotteryCallback } from './features/lottery';
import {
  handleCrashCallback,
  handleDicePokerCallback,
  handlePenaltyCallback,
  handleRpsCallback,
  handleThimblesCallback,
  isNewGamesProtectedMsg,
  startDicePokerGame,
  startOrJoinMultiplayerCrash,
  startPenaltyGame,
  startRpsMenu,
  startThimblesGame,
  sweepExpiredNewGames
} from './games/newGames';
import {
  handleAuctionCallback,
  isAuctionProtectedMsg,
  sweepExpiredAuctions
} from './features/auction';
import {
  handleMultiBlackjackCallback,
  isMultiBlackjackProtectedMsg,
  startMultiBlackjackLobby,
  sweepExpiredMultiBlackjack
} from './games/multiBlackjack';
import {
  handleBlitzCallback,
  isBlitzProtectedMsg,
  sweepExpiredBlitzes
} from './features/blitz';
import {
  claimTalismanPassiveIncome,
  formatHourlyRate,
  getTalismanIncomeSnapshot,
  syncTalismanPassiveIncome
} from './features/talismanIncome';

export type {
  BotTransport,
  IncomingChat,
  IncomingUser,
  InlineButton,
  InlineKeyboard
};

interface RussianLobby {
  id: string;
  chatId: string;
  stake: number;
  creatorId: string;
  players: { userId: string; firstName: string; isLastDodep: boolean }[];
  status: 'waiting' | 'playing' | 'finished';
  chamber: number; // 0..5 current slot
  bulletSlot: number; // 0..5 bullet slot
  turnIndex: number;
  messageId: string | null;
  historyLines: string[];
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
}

interface MinesSession {
  id: string;
  chatId: string;
  userId: string;
  userName: string;
  stake: number;
  bombsCount: number;
  isLastDodep: boolean;
  mines: Set<number>;
  opened: Set<number>;
  status: 'playing' | 'cashed' | 'busted';
  messageId: string | null;
  createdAt: number;
}

interface DiceSession {
  id: string;
  chatId: string;
  userId: string;
  userName: string;
  stake: number;
  isLastDodep: boolean;
  botRoll: number;
  status: 'waiting_player' | 'rolling' | 'finished';
  messageId: string | null;
  createdAt: number;
}

interface BlackjackCard {
  rank: string;
  suit: string;
  value: number;
}

interface BlackjackSession {
  id: string;
  chatId: string;
  userId: string;
  userName: string;
  stake: number;
  isLastDodep: boolean;
  deck: BlackjackCard[];
  playerHand: BlackjackCard[];
  dealerHand: BlackjackCard[];
  doubled: boolean;
  status: 'playing' | 'finished';
  messageId: string | null;
  createdAt: number;
}

interface RaceBet {
  userId: string;
  firstName: string;
  lane: number; // 0..3
  amount: number;
  isLastDodep: boolean;
}

interface RaceLobby {
  id: string;
  chatId: string;
  stake: number;
  creatorId: string;
  bets: RaceBet[];
  positions: number[]; // length 4, 0..12
  status: 'waiting' | 'running' | 'finished';
  messageId: string | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
}

interface HiloCard {
  rank: string;
  suit: string;
  rankVal: number; // 2..14
}

interface HiloSession {
  id: string;
  chatId: string;
  userId: string;
  userName: string;
  stake: number;
  isLastDodep: boolean;
  deck: HiloCard[];
  currentCard: HiloCard;
  trail: HiloCard[];
  currentMult: number;
  streak: number;
  status: 'playing' | 'finished';
  messageId: string | null;
  createdAt: number;
}

interface DuelLobby {
  id: string;
  chatId: string;
  creatorId: string;
  creatorName: string;
  creatorSide: 'heads' | 'tails';
  stake: number;
  isLastDodep: boolean;
  status: 'waiting' | 'flipping' | 'finished';
  messageId: string | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
}

interface LadderSession {
  id: string;
  chatId: string;
  userId: string;
  userName: string;
  stake: number;
  mode: 'easy' | 'hard';
  isLastDodep: boolean;
  floor: number; // 0..6 (next floor to step on)
  floors: number[][]; // 6 floors x 3 cols: 1 = safe, 0 = trap
  pickedCols: number[];
  status: 'playing' | 'finished';
  messageId: string | null;
  createdAt: number;
}

interface PotEntry {
  instanceId: string;
  talismanId: string;
  userId: string;
  firstName: string;
  weight: number;
}

interface TalismanPotLobby {
  id: string;
  chatId: string;
  creatorId: string;
  entries: PotEntry[];
  status: 'waiting' | 'spinning' | 'finished';
  messageId: string | null;
  autoSpinTimer: NodeJS.Timeout | null;
  countdownEndsAt: number | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
}

const russianLobbies = new Map<string, RussianLobby>();
const minesSessions = new Map<string, MinesSession>();
const diceSessions = new Map<string, DiceSession>();
const blackjackSessions = new Map<string, BlackjackSession>();
const raceLobbies = new Map<string, RaceLobby>();
const hiloSessions = new Map<string, HiloSession>();
const duelLobbies = new Map<string, DuelLobby>();
const ladderSessions = new Map<string, LadderSession>();
const potLobbies = new Map<string, TalismanPotLobby>();

function getLobbyTransport(
  source?: 'telegram' | 'simulator',
  chatId?: string,
  tr?: BotTransport | null
): BotTransport | null {
  return resolveRuntimeTransport(source, chatId, tr);
}

function scheduleCleanupMessage(
  transport: BotTransport,
  chatId: string,
  messageId: string | null | undefined,
  delayMs = 8000
): void {
  if (!messageId || !transport.deleteMessage) return;
  if (isServerlessRuntime()) {
    trackBotMessage(chatId, messageId, delayMs);
    return;
  }
  const del = transport.deleteMessage;
  setTimeout(() => {
    void del(chatId, messageId);
  }, delayMs);
}

export function isProtectedInteractiveMessage(msgId: string): boolean {
  if (isNewGamesProtectedMsg(msgId)) return true;
  if (isAuctionProtectedMsg(msgId)) return true;
  if (isMultiBlackjackProtectedMsg(msgId)) return true;
  if (isBlitzProtectedMsg(msgId)) return true;
  for (const l of russianLobbies.values()) if (l.messageId === msgId) return true;
  for (const r of raceLobbies.values()) if (r.messageId === msgId) return true;
  for (const d of duelLobbies.values()) if (d.messageId === msgId) return true;
  for (const p of potLobbies.values()) if (p.messageId === msgId) return true;
  for (const s of minesSessions.values()) if (s.messageId === msgId) return true;
  for (const s of diceSessions.values()) if (s.messageId === msgId) return true;
  for (const s of blackjackSessions.values()) if (s.messageId === msgId) return true;
  for (const s of hiloSessions.values()) if (s.messageId === msgId) return true;
  for (const s of ladderSessions.values()) if (s.messageId === msgId) return true;
  for (const c of Object.values(getDb().chats)) {
    for (const r of c.loanRequests || []) {
      if (r.status === 'open' && r.messageId === msgId) return true;
    }
  }
  return false;
}

export async function sweepExpiredLobbies(): Promise<void> {
  const now = Date.now();
  const db = getDb();

  // 1. Russian Roulette idle waiting lobbies (4 min)
  for (const [sid, lobby] of Array.from(russianLobbies.entries())) {
    if (lobby.status === 'waiting' && now - lobby.createdAt >= LOBBY_IDLE_TTL_MS) {
      russianLobbies.delete(sid);
      lobby.status = 'finished';
      markRuntimeDirty();
      const chat = db.chats[lobby.chatId];
      for (const p of lobby.players) {
        const ps = chat?.players[p.userId];
        if (ps) ps.balance += lobby.stake;
      }
      scheduleSave();
      addBotLog({
        source: 'scheduler',
        chatId: lobby.chatId,
        chatTitle: chat?.title || lobby.chatId,
        event: 'Таймаут лобби (Русская рулетка)',
        detail: `Ставки (${lobby.stake} 🪙 × ${lobby.players.length}) возвращены`
      });
      const tr = getLobbyTransport(lobby.transportSource, lobby.chatId, lobby.transport);
      if (lobby.messageId && tr) {
        await tr.editMessage(
          lobby.chatId,
          lobby.messageId,
          `⏱ Лобби Русской рулетки закрыто по таймауту (4 мин). Все ставки (${lobby.stake} 🪙) возвращены.`,
          [[{ text: '🏠 В меню', callbackData: 'menu' }]]
        );
      }
    }
  }

  // 2. Cockroach Races idle waiting lobbies (4 min)
  for (const [sid, lobby] of Array.from(raceLobbies.entries())) {
    if (lobby.status === 'waiting' && now - lobby.createdAt >= LOBBY_IDLE_TTL_MS) {
      raceLobbies.delete(sid);
      lobby.status = 'finished';
      markRuntimeDirty();
      const chat = db.chats[lobby.chatId];
      for (const b of lobby.bets) {
        const ps = chat?.players[b.userId];
        if (ps) ps.balance += b.amount;
      }
      scheduleSave();
      addBotLog({
        source: 'scheduler',
        chatId: lobby.chatId,
        chatTitle: chat?.title || lobby.chatId,
        event: 'Таймаут лобби (Тараканьи бега)',
        detail: `Ставки (${lobby.bets.length} уч.) возвращены`
      });
      const tr = getLobbyTransport(lobby.transportSource, lobby.chatId, lobby.transport);
      if (lobby.messageId && tr) {
        await tr.editMessage(
          lobby.chatId,
          lobby.messageId,
          `⏱ Забег тараканов отменён по таймауту (4 мин). Все ставки возвращены.`,
          [[{ text: '🏠 В меню', callbackData: 'menu' }]]
        );
      }
    }
  }

  // 3. Duel 1v1 idle waiting lobbies (4 min)
  for (const [sid, lobby] of Array.from(duelLobbies.entries())) {
    if (lobby.status === 'waiting' && now - lobby.createdAt >= LOBBY_IDLE_TTL_MS) {
      duelLobbies.delete(sid);
      lobby.status = 'finished';
      markRuntimeDirty();
      const chat = db.chats[lobby.chatId];
      const creator = chat?.players[lobby.creatorId];
      if (creator) creator.balance += lobby.stake;
      scheduleSave();
      addBotLog({
        source: 'scheduler',
        chatId: lobby.chatId,
        chatTitle: chat?.title || lobby.chatId,
        event: 'Таймаут лобби (Дуэль 1×1)',
        detail: `Ставка ${lobby.stake} 🪙 возвращена ${lobby.creatorName}`
      });
      const tr = getLobbyTransport(lobby.transportSource, lobby.chatId, lobby.transport);
      if (lobby.messageId && tr) {
        await tr.editMessage(
          lobby.chatId,
          lobby.messageId,
          `⏱ Вызов Дуэли 1×1 закрыт по таймауту (4 мин). Ставка ${lobby.stake} 🪙 возвращена.`,
          [[{ text: '🏠 В меню', callbackData: 'menu' }]]
        );
      }
    }
  }

  // 4. Talisman Pot countdown finish (serverless) or idle waiting lobbies (4 min without spin)
  for (const [pid, pot] of Array.from(potLobbies.entries())) {
    const tr = getLobbyTransport(pot.transportSource, pot.chatId, pot.transport);
    const chat = db.chats[pot.chatId];
    if (pot.status === 'waiting' && pot.countdownEndsAt && now >= pot.countdownEndsAt && chat && tr) {
      await spinPotAndPayout(tr, chat, pot);
      continue;
    }
    if (pot.status === 'waiting' && !pot.autoSpinTimer && now - pot.createdAt >= LOBBY_IDLE_TTL_MS) {
      potLobbies.delete(pid);
      pot.status = 'finished';
      markRuntimeDirty();
      if (chat) refundPotEntries(chat, pot.entries);
      scheduleSave();
      addBotLog({
        source: 'scheduler',
        chatId: pot.chatId,
        chatTitle: chat?.title || pot.chatId,
        event: 'Таймаут котла талисманов',
        detail: `Возвращено ${pot.entries.length} талисманов владельцам`
      });
      if (pot.messageId && tr) {
        await tr.editMessage(
          pot.chatId,
          pot.messageId,
          `⏱ Общий котёл талисманов закрыт по таймауту (4 мин). Все талисманы (${pot.entries.length} шт.) возвращены в шкатулки.`,
          [[{ text: '🏠 В меню', callbackData: 'menu' }]]
        );
      }
    }
  }

  // 5. Prune abandoned solo sessions older than 20 minutes from RAM
  const SOLO_TTL = 20 * 60 * 1000;
  for (const [id, s] of minesSessions.entries()) if (now - s.createdAt >= SOLO_TTL) minesSessions.delete(id);
  for (const [id, s] of diceSessions.entries()) if (now - s.createdAt >= SOLO_TTL) diceSessions.delete(id);
  for (const [id, s] of blackjackSessions.entries()) if (now - s.createdAt >= SOLO_TTL) blackjackSessions.delete(id);
  for (const [id, s] of hiloSessions.entries()) if (now - s.createdAt >= SOLO_TTL) hiloSessions.delete(id);
  for (const [id, s] of ladderSessions.entries()) if (now - s.createdAt >= SOLO_TTL) ladderSessions.delete(id);

  await sweepExpiredNewGames(now);
  await sweepExpiredAuctions(now);
  await sweepExpiredMultiBlackjack(now);
  await sweepExpiredBlitzes(now);
}

function createShuffledDeck(): BlackjackCard[] {
  const suits = ['♠️', '♥️', '♦️', '♣️'];
  const ranks: { rank: string; value: number }[] = [
    { rank: '2', value: 2 },
    { rank: '3', value: 3 },
    { rank: '4', value: 4 },
    { rank: '5', value: 5 },
    { rank: '6', value: 6 },
    { rank: '7', value: 7 },
    { rank: '8', value: 8 },
    { rank: '9', value: 9 },
    { rank: '10', value: 10 },
    { rank: 'J', value: 10 },
    { rank: 'Q', value: 10 },
    { rank: 'K', value: 10 },
    { rank: 'A', value: 11 }
  ];
  const deck: BlackjackCard[] = [];
  for (const suit of suits) {
    for (const r of ranks) {
      deck.push({ rank: r.rank, suit, value: r.value });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calcBlackjackScore(cards: BlackjackCard[]): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += c.value;
    if (c.rank === 'A') aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function formatBlackjackHand(cards: BlackjackCard[]): string {
  return cards.map((c) => `[${c.rank}${c.suit}]`).join(' ');
}

export type GameGenre = 'fast' | 'pvp' | 'skill';
export type MenuSection = 'home' | 'games' | 'talismans' | 'profile';

const playerActiveGameGenre = new Map<string, GameGenre>();

function normalizeGameGenre(raw?: string): GameGenre | null {
  if (raw === 'fast' || raw === 'pvp' || raw === 'skill') return raw;
  return null;
}

function getPlayerGameGenre(chatId: string, userId: string): GameGenre {
  return playerActiveGameGenre.get(`${chatId}:${userId}`) || 'fast';
}

function setPlayerGameGenre(chatId: string, userId: string, genre: GameGenre): void {
  const key = `${chatId}:${userId}`;
  if (!playerActiveGameGenre.has(key) && playerActiveGameGenre.size >= 5000) {
    const oldest = playerActiveGameGenre.keys().next().value;
    if (oldest !== undefined) playerActiveGameGenre.delete(oldest);
  }
  playerActiveGameGenre.set(key, genre);
}

const GAME_GENRE_META: Record<GameGenre, { short: string; title: string; subtitle: string }> = {
  fast: {
    short: '⚡ Быстрые',
    title: '⚡ Быстрые игры',
    subtitle: 'Мгновенные заносы: Рулетка, Слот 777, Плинко, Кости, Напёрстки и К-Н-Б.'
  },
  pvp: {
    short: '⚔️ С чатом',
    title: '⚔️ Мультиплеер и PvP в чате',
    subtitle: 'Общий Краш, Русская рулетка, Бега, Стол 21 (2–4), Дуэль 1×1 и К-Н-Б PvP.'
  },
  skill: {
    short: '🧠 Тактика',
    title: '🧠 Тактика и кэшаут',
    subtitle: 'Мины 5×5, Лесенка додепа, Блэкджек 21, Hi-Lo, Пенальти и Покер на костях.'
  }
};

export function buildMainMenuText(
  chat: ChatState,
  player?: PlayerState,
  section: MenuSection = 'home',
  genre: GameGenre = 'fast'
): string {
  const ownerBadge = player ? ` · 👤 ${playerLabel(chat, player)}` : '';
  const balanceLine = player
    ? `🪙 Баланс: ${player.balance} фантиков · Чат: «${chat.title}»`
    : `Чат: «${chat.title}» · Стартовый банк новичка — 1000 🪙.`;

  if (section === 'games') {
    const meta = GAME_GENRE_META[genre] || GAME_GENRE_META.fast;
    return [
      `🎮 ИГРОВОЙ ЗАЛ ДЯДИ ДЕПА${ownerBadge}`,
      balanceLine,
      `📂 Жанр: ${meta.title}`,
      `${meta.subtitle}`,
      ``,
      `Переключай жанр сверху и выбирай стол 👇`
    ].join('\n');
  }

  if (section === 'talismans') {
    const col = player ? getPlayerCollectionSummary(player) : { count: 0, recycleTotal: 0, uniqueCount: 0 };
    const eqDef =
      player?.equippedTalismanId && player.talismans?.some((t) => t.talismanId === player.equippedTalismanId)
        ? TALISMAN_BY_ID[player.equippedTalismanId]
        : null;
    const chatUniquesOwned = Object.keys(chat.uniqueTalismans || {}).length;
    const incomeSnap = player ? getTalismanIncomeSnapshot(player) : null;
    const incomeLines = incomeSnap
      ? [
          `🏦 Доход от талисманов: +${formatHourlyRate(incomeSnap.hourlyRate)} 🪙/ч`,
          `💰 Накоплено: ${incomeSnap.pendingCoins}/${incomeSnap.capCoins} 🪙 (максимум копится 12 часов)${incomeSnap.isFull ? ' ✅' : ''}`
        ]
      : [];
    return [
      `🧳 ТАЛИСМАНЫ, КЕЙСЫ И РЫНОК${ownerBadge}`,
      balanceLine,
      `🎒 В шкатулке: ${col.count} шт. (ценность: ${col.recycleTotal} 🪙, уников: ${col.uniqueCount})`,
      `✨ Значок: ${eqDef ? `${eqDef.emoji} ${eqDef.name}` : 'не надет'} · 🏛️ Уников в чате: ${chatUniquesOwned}/${UNIQUE_TALISMANS.length}`,
      ...incomeLines,
      ``,
      `Открывай кейсы, собирай пассивный доход, плавь 5→1 или торгуй на Аукционе 👇`
    ]
      .filter((x, i, arr) => x !== '' || arr[i - 1] !== '')
      .join('\n');
  }

  if (section === 'profile') {
    const games = player?.stats.gamesPlayed || 0;
    const wins = player?.stats.winsCount || 0;
    const winrate = games > 0 ? `${Math.round((wins / games) * 100)}%` : '0%';
    const owed = player
      ? getActiveLoansForBorrower(chat, player.userId).reduce((s, l) => s + getRemainingDebt(l), 0)
      : 0;
    const lent = player
      ? getActiveLoansForLender(chat, player.userId).reduce((s, l) => s + getRemainingDebt(l), 0)
      : 0;
    const openReq = player
      ? (chat.loanRequests || []).find((r) => r.borrowerId === player.userId && r.status === 'open')
      : undefined;
    const achCount = player?.achievements?.length || 0;
    const dqDone = player?.dailyQuests?.quests?.filter((q) => q.done).length || 0;
    const incomeSnap = player ? getTalismanIncomeSnapshot(player) : null;

    return [
      `🪪 ПРОФИЛЬ, ДЕЙЛИКИ И ДОЛГИ${ownerBadge}`,
      balanceLine,
      `📊 Игр: ${games} · Побед: ${wins} (${winrate}) · 🏅 Ачивок: ${achCount}/12`,
      `📋 Дейлики: ${dqDone}/3 · 🤝 Должен: ${owed} 🪙 · Выдано: ${lent} 🪙${openReq ? ` · 📣 Открытая заявка: ${openReq.principal} 🪙` : ''}`,
      incomeSnap && (incomeSnap.hourlyRate > 0 || incomeSnap.pendingCoins > 0)
        ? `🏦 Доход от талисманов: +${formatHourlyRate(incomeSnap.hourlyRate)} 🪙/ч · накоплено ${incomeSnap.pendingCoins}/${incomeSnap.capCoins} 🪙 (макс. 12 ч)`
        : '',
      ``,
      `Управляй финансами, дейликами и лотереей 👇`
    ]
      .filter((x, i, arr) => x !== '' || arr[i - 1] !== '')
      .join('\n');
  }

  // Default: 'home'
  const talsCount = player?.talismans?.length || 0;
  const owed = player
    ? getActiveLoansForBorrower(chat, player.userId).reduce((s, l) => s + getRemainingDebt(l), 0)
    : 0;
  const dqDone = player?.dailyQuests?.quests?.filter((q) => q.done).length || 0;
  const incomeSnap = player ? getTalismanIncomeSnapshot(player) : null;
  const incomePart =
    incomeSnap && (incomeSnap.hourlyRate > 0 || incomeSnap.pendingCoins > 0)
      ? ` · 🏦 Доход: +${formatHourlyRate(incomeSnap.hourlyRate)}/ч (накоплено ${incomeSnap.pendingCoins}/${incomeSnap.capCoins} 🪙)`
      : '';

  return [
    `🧔‍♂️ Дядя Деп за столом!${ownerBadge}`,
    balanceLine,
    `🎒 Талисманы: ${talsCount} шт. · 📋 Дейлики: ${dqDone}/3${owed > 0 ? ` · 🤝 Долг: ${owed} 🪙` : ''}${incomePart}`,
    ``,
    `Выбирай раздел 👇`
  ].join('\n');
}

export function buildMainMenuKeyboard(
  section: MenuSection = 'home',
  genre: GameGenre = 'fast',
  chat?: ChatState,
  player?: PlayerState
): InlineKeyboard {
  if (section === 'games') {
    const genres: GameGenre[] = ['fast', 'pvp', 'skill'];
    const genreRow: InlineButton[] = genres.map((g) => {
      const label = GAME_GENRE_META[g].short;
      return {
        text: g === genre ? `• ${label} •` : label,
        callbackData: `menu:games:${g}`
      };
    });

    if (genre === 'pvp') {
      return [
        genreRow,
        [
          { text: '🚀 Общий Краш', callbackData: 'g:crash' },
          { text: '🔫 Русская рулетка', callbackData: 'g:russian' }
        ],
        [
          { text: '🪳 Тараканьи бега', callbackData: 'g:races' },
          { text: '🃏 Стол 21 (2–4)', callbackData: 'g:bjtable' }
        ],
        [
          { text: '🪙 Дуэль 1×1 (PvP)', callbackData: 'g:duel' },
          { text: '🪨✂️📄 К-Н-Б (PvP)', callbackData: 'g:rps' }
        ],
        [{ text: '↩️ Главное меню', callbackData: 'menu:home' }]
      ];
    }

    if (genre === 'skill') {
      return [
        genreRow,
        [
          { text: '💣 Мины / Сапёр', callbackData: 'g:mines' },
          { text: '🪜 Лесенка додепа', callbackData: 'g:ladder' }
        ],
        [
          { text: '🃏 Блэкджек (21)', callbackData: 'g:blackjack' },
          { text: '↕️ Больше / Меньше', callbackData: 'g:hilo' }
        ],
        [
          { text: '⚽ Пенальти', callbackData: 'g:penalty' },
          { text: '🎲 Покер на костях', callbackData: 'g:dicepoker' }
        ],
        [{ text: '↩️ Главное меню', callbackData: 'menu:home' }]
      ];
    }

    // Default: 'fast'
    return [
      genreRow,
      [
        { text: '🎡 Рулетка', callbackData: 'g:roulette' },
        { text: '🎰 Слот 777', callbackData: 'g:slots' }
      ],
      [
        { text: '🔺 Плинко', callbackData: 'g:plinko' },
        { text: '🎲 Кости (Догон)', callbackData: 'g:dice' }
      ],
      [
        { text: '🥃 Напёрстки', callbackData: 'g:thimbles' },
        { text: '🪨✂️📄 К-Н-Б', callbackData: 'g:rps' }
      ],
      [{ text: '↩️ Главное меню', callbackData: 'menu:home' }]
    ];
  }

  if (section === 'talismans') {
    const colCount = player ? player.talismans?.length || 0 : 0;
    const chatUniquesOwned = chat ? Object.keys(chat.uniqueTalismans || {}).length : 0;
    const incomeSnap = player ? getTalismanIncomeSnapshot(player) : null;
    const rows: InlineKeyboard = [
      [
        { text: '🛒 Купить кейс', callbackData: 'tl:shop' },
        { text: `🎒 Шкатулка (${colCount})`, callbackData: 'tl:bag:0' }
      ],
      [
        { text: '⚗️ Крафт (5→1)', callbackData: 'tl:craft' },
        { text: `🏛️ Пантеон (${chatUniquesOwned}/${UNIQUE_TALISMANS.length})`, callbackData: 'tl:pantheon' }
      ],
      [
        { text: '🍯 Общий Котёл', callbackData: 'pot:menu' },
        { text: '🔨 Аукцион реликвий', callbackData: 'auc:menu' }
      ]
    ];
    if (incomeSnap && (incomeSnap.hourlyRate > 0 || incomeSnap.pendingCoins > 0)) {
      rows.push([
        { text: `💰 Собрать накопленное (+${incomeSnap.pendingCoins} 🪙)`, callbackData: 'tl:claim' }
      ]);
    }
    rows.push([{ text: '↩️ Главное меню', callbackData: 'menu:home' }]);
    return rows;
  }

  if (section === 'profile') {
    return [
      [
        { text: '📊 Статистика и ачивки', callbackData: 'me:view' },
        { text: '📋 Дейлики (+300)', callbackData: 'dq:menu' }
      ],
      [
        { text: '🤝 Долги и займы', callbackData: 'ln:menu' },
        { text: '🎟️ Лотерея (20:55)', callbackData: 'lot:menu' }
      ],
      [
        { text: '🏆 Доска почёта', callbackData: 'top' },
        { text: `💸 Бонус (+${ZERO_BONUS_AMOUNT})`, callbackData: 'bonus' }
      ],
      [{ text: '↩️ Главное меню', callbackData: 'menu:home' }]
    ];
  }

  // Default: 'home'
  return [
    [
      { text: '🎮 Игры', callbackData: 'menu:games' },
      { text: '🧳 Талисманы', callbackData: 'menu:talismans' }
    ],
    [
      { text: '🪪 Профиль и долги', callbackData: 'menu:profile' },
      { text: '🎟️ Лотерея (20:55)', callbackData: 'lot:menu' }
    ],
    [
      { text: '🏆 Доска почёта', callbackData: 'top' },
      { text: `💸 Бонус (+${ZERO_BONUS_AMOUNT})`, callbackData: 'bonus' }
    ]
  ];
}

function buildStakeKeyboard(game: GameType, balance: number): InlineKeyboard {
  return [
    [
      { text: '50 🪙', callbackData: `b:${game}:50` },
      { text: '100 🪙', callbackData: `b:${game}:100` },
      { text: '250 🪙', callbackData: `b:${game}:250` },
      { text: '500 🪙', callbackData: `b:${game}:500` }
    ],
    [{ text: `🔥 Ва-банк (${balance} 🪙)`, callbackData: `b:${game}:all` }],
    [
      { text: '↩️ К играм', callbackData: 'menu:games' },
      { text: '🏠 В меню', callbackData: 'menu:home' }
    ]
  ];
}

function resolveStakeAmount(player: PlayerState, rawStake: string, isLastDodep: boolean): { ok: true; amount: number } | { ok: false; reason: string } {
  const ghostMs = getGhostRemainingMs(player);
  if (ghostMs > 0) {
    return {
      ok: false,
      reason: `${pickNonRepeatingPhrase('ghostBlocked', []).text}\n⏳ Осталось быть Призраком: ${formatDuration(ghostMs)}`
    };
  }
  if (player.balance <= 0) {
    return {
      ok: false,
      reason: `ZERO_BALANCE`
    };
  }

  let amount = rawStake === 'all' ? player.balance : parseInt(rawStake, 10);
  if (Number.isNaN(amount) || amount <= 0) {
    return { ok: false, reason: 'Некорректная ставка.' };
  }

  if (isLastDodep && amount > player.balance) {
    // Allow all-in last dodep if player still has some balance!
    amount = player.balance;
  }

  if (amount > player.balance) {
    return {
      ok: false,
      reason: `🪙 Не хватает фантиков! Твой баланс: ${player.balance}, а ставка: ${amount}. Выбери ставку поменьше или жми Ва-банк.`
    };
  }
  return { ok: true, amount };
}

export function getPlayerCollectionSummary(player: PlayerState): {
  count: number;
  uniqueCount: number;
  recycleTotal: number;
  score: number;
} {
  const list = player.talismans || [];
  let uniqueCount = 0;
  let recycleTotal = 0;
  for (const item of list) {
    const def = TALISMAN_BY_ID[item.talismanId];
    if (!def) continue;
    if (def.rarity === 'unique') {
      uniqueCount += 1;
    } else {
      recycleTotal += def.recycleValue;
    }
  }
  const score = uniqueCount * 5000 + recycleTotal;
  return { count: list.length, uniqueCount, recycleTotal, score };
}

export function buildLeaderboardText(chat: ChatState): string {
  const players = Object.values(chat.players);
  if (players.length === 0) {
    return `🏆 Доска позора и почета чата «${chat.title}»\n\nПока никто не сделал даже первого депа. Жмите /start!`;
  }

  const TOTAL_NOMINATIONS = 9;
  const positionCounts = new Map<string, number>();
  const addPoint = (userId?: string) => {
    if (!userId) return;
    positionCounts.set(userId, (positionCounts.get(userId) || 0) + 1);
  };

  const richest = [...players].sort((a, b) => b.balance - a.balance)[0];
  if (richest && richest.balance > 0) addPoint(richest.userId);

  const feeder = [...players].sort((a, b) => b.stats.totalLost - a.stats.totalLost)[0];
  if (feeder && feeder.stats.totalLost > 0) addPoint(feeder.userId);

  const coldHead = [...players].sort((a, b) => b.stats.maxCrashMultiplier - a.stats.maxCrashMultiplier)[0];
  if (coldHead && coldHead.stats.maxCrashMultiplier > 0) addPoint(coldHead.userId);

  const dodepKing = [...players].sort((a, b) => b.stats.lastDodepWins - a.stats.lastDodepWins)[0];
  if (dodepKing && dodepKing.stats.lastDodepWins > 0) addPoint(dodepKing.userId);

  const debtByBorrower = new Map<string, number>();
  for (const loan of chat.loans || []) {
    if (loan.status !== 'active') continue;
    const rem = getRemainingDebt(loan);
    if (rem > 0) {
      debtByBorrower.set(loan.borrowerId, (debtByBorrower.get(loan.borrowerId) || 0) + rem);
    }
  }

  let topDebtorLine = `🏦 Главный должник чата: чисто — в чате никто никому не должен`;
  if (debtByBorrower.size > 0) {
    const sortedDebtors = [...debtByBorrower.entries()].sort((a, b) => b[1] - a[1]);
    const [topId, topDebt] = sortedDebtors[0];
    const debtorPlayer = chat.players[topId];
    const debtorName = debtorPlayer ? playerLabel(chat, debtorPlayer) : 'Игрок';
    topDebtorLine = `🏦 Главный должник чата: ${debtorName} — торчит пацанам ${topDebt} фантиков`;
    addPoint(topId);
  }

  const ghostKing = [...players].sort((a, b) => (b.stats.ghostCount || 0) - (a.stats.ghostCount || 0))[0];
  const ghostCountVal = ghostKing?.stats.ghostCount || 0;
  if (ghostKing && ghostCountVal > 0) addPoint(ghostKing.userId);
  const ghostLine =
    ghostCountVal > 0
      ? `👻 Любимец барабана (Призрак чата): ${playerLabel(chat, ghostKing)} — ловил пулю ${ghostCountVal} раз(а)`
      : `👻 Любимец барабана (Призрак чата): пока все выжили (0 выстрелов)`;

  const allInKing = [...players].sort((a, b) => (b.stats.allInCount || 0) - (a.stats.allInCount || 0))[0];
  const allInCountVal = allInKing?.stats.allInCount || 0;
  if (allInKing && allInCountVal > 0) addPoint(allInKing.userId);
  const allInLine =
    allInCountVal > 0
      ? `🧨 Маньяк ва-банка: ${playerLabel(chat, allInKing)} — заряжал на все бабки ${allInCountVal} раз(а)`
      : `🧨 Маньяк ва-банка: пока без безбашенных заходов (0)`;

  const bonusKing = [...players].sort((a, b) => (b.stats.zeroBonusCount || 0) - (a.stats.zeroBonusCount || 0))[0];
  const bonusCountVal = bonusKing?.stats.zeroBonusCount || 0;
  if (bonusKing && bonusCountVal > 0) addPoint(bonusKing.userId);
  const bonusLine =
    bonusCountVal > 0
      ? `🤲 Вечный клиент кассы (+${ZERO_BONUS_AMOUNT}): ${playerLabel(chat, bonusKing)} — вставал с нуля ${bonusCountVal} раз(а)`
      : `🤲 Вечный клиент кассы (+${ZERO_BONUS_AMOUNT}): все пока при своих (0)`;

  const collectorRanked = [...players]
    .map((p) => ({ p, col: getPlayerCollectionSummary(p) }))
    .sort((a, b) => b.col.score - a.col.score || b.col.count - a.col.count);
  const topCol = collectorRanked[0];
  let collectorLine = `🏺 Коллекционер чата: шкатулки пока пусты (0 талисманов)`;
  if (topCol && topCol.col.count > 0) {
    addPoint(topCol.p.userId);
    const uniqText = topCol.col.uniqueCount > 0 ? `, уников: ${topCol.col.uniqueCount}` : '';
    collectorLine = `🏺 Коллекционер чата: ${playerLabel(chat, topCol.p)} — ${topCol.col.count} шт. (актив: ${topCol.col.recycleTotal} 🪙${uniqText})`;
  }

  const rankedHolders = [...positionCounts.entries()]
    .map(([uid, count]) => ({ player: chat.players[uid], count }))
    .filter((x) => Boolean(x.player))
    .sort((a, b) => b.count - a.count || b.player.balance - a.player.balance);

  let statOfStatsLines: string[];
  if (rankedHolders.length > 0) {
    const leader = rankedHolders[0];
    const others = rankedHolders
      .slice(0, 3)
      .map((h) => `${displayName(h.player)} (${h.count}/${TOTAL_NOMINATIONS})`)
      .join(' · ');
    statOfStatsLines = [
      `📊 СТАТИСТИКА СТАТИСТИКИ:`,
      `🏆 Главный доминатор доски: ${playerLabel(chat, leader.player)} — занимает ${leader.count}/${TOTAL_NOMINATIONS} позиций!`,
      ...(rankedHolders.length > 1 ? [`📌 Зачёт по позициям: ${others}`] : [])
    ];
  } else {
    statOfStatsLines = [`📊 СТАТИСТИКА СТАТИСТИКИ: пока 0/${TOTAL_NOMINATIONS} — пора крутить!`];
  }

  return [
    `🏆 ДОСКА ПОЗОРА И ПОЧЕТА — «${chat.title}»`,
    ``,
    `👑 Олигарх чата: ${playerLabel(chat, richest)} — ${richest.balance} фантиков`,
    `🤡 Главный кормилец казино: ${feeder.stats.totalLost > 0 ? `${playerLabel(chat, feeder)} — слито ${feeder.stats.totalLost} фантиков` : 'пока никто не слился (0)'}`,
    `🧊 Холодная голова (Краш): ${coldHead.stats.maxCrashMultiplier > 0 ? `${playerLabel(chat, coldHead)} — рекорд x${coldHead.stats.maxCrashMultiplier.toFixed(2)}` : 'никто ещё не летал (0)'}`,
    `♻️ Король ласт-додепов: ${dodepKing.stats.lastDodepWins > 0 ? `${playerLabel(chat, dodepKing)} — камбэков x2: ${dodepKing.stats.lastDodepWins}` : 'камбэков x2 пока нет (0)'}`,
    topDebtorLine,
    ghostLine,
    allInLine,
    bonusLine,
    collectorLine,
    ``,
    ...statOfStatsLines,
    ``,
    `💬 ${nextPhrase(chat, 'leaderboardFooters')}`
  ].join('\n');
}

export function buildEveningSummaryText(chat: ChatState): string {
  const players = Object.values(chat.players);
  if (players.length === 0) {
    return `🌙 ВЕЧЕРНЯЯ СВОДКА ДЯДИ ДЕПА (21:00)\n\nВ чате «${chat.title}» за последние сутки пока никто не заходил за стол.`;
  }

  const rows = players
    .map((p) => {
      const base = p.dailyBaseline || createBaselineFromPlayer(p);
      const games = Math.max(0, (p.stats.gamesPlayed || 0) - (base.gamesPlayed || 0));
      const won = Math.max(0, (p.stats.totalWon || 0) - (base.totalWon || 0));
      const lost = Math.max(0, (p.stats.totalLost || 0) - (base.totalLost || 0));
      const cases = Math.max(0, (p.stats.casesOpened || 0) - (base.casesOpened || 0));
      const delta = p.balance - base.balance;
      const active = games > 0 || won > 0 || lost > 0 || cases > 0 || delta !== 0;
      return { p, games, won, lost, cases, delta, active };
    })
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.delta - a.delta || b.games - a.games || b.p.balance - a.p.balance;
    });

  const activeRows = rows.filter((r) => r.active);
  const listToRender = (activeRows.length > 0 ? rows : rows.slice(0, 10)).slice(0, 20);

  const playerLines: string[] = [];
  listToRender.forEach((r, idx) => {
    const deltaSign = r.delta > 0 ? '+' : '';
    const deltaEmoji = r.delta > 0 ? '📈' : r.delta < 0 ? '📉' : '➖';
    const casesSuffix = r.cases > 0 ? ` | 🧳 Кейсов: ${r.cases}` : '';
    playerLines.push(
      `${idx + 1}. ${playerLabel(chat, r.p)}`,
      `   🎲 Игр: ${r.games}${casesSuffix} | 🟢 Поднял: +${r.won} | 🔴 Слил: -${r.lost}`,
      `   ${deltaEmoji} Прирост за сутки: ${deltaSign}${r.delta} 🪙 (баланс: ${r.p.balance} 🪙)`
    );
  });

  if (rows.length > listToRender.length) {
    playerLines.push(`… и ещё ${rows.length - listToRender.length} участник(ов) тихо сидели на скамейке.`);
  }

  const totalGames = rows.reduce((s, r) => s + r.games, 0);
  const totalWon = rows.reduce((s, r) => s + r.won, 0);
  const totalLost = rows.reduce((s, r) => s + r.lost, 0);
  const totalCases = rows.reduce((s, r) => s + r.cases, 0);

  const topGainer = [...activeRows].sort((a, b) => b.delta - a.delta)[0];
  const topLoser = [...activeRows].sort((a, b) => a.delta - b.delta)[0];

  const footerSummary: string[] = [
    `📊 ИТОГ ЗА СУТКИ ПО ЧАТУ:`,
    `• Всего игр: ${totalGames} | Кейсов открыто: ${totalCases}`,
    `• Суммарно подняли: +${totalWon} 🪙 | Слили: -${totalLost} 🪙`
  ];
  if (topGainer && topGainer.delta > 0) {
    footerSummary.push(`🚀 Главный плюс дня: ${playerLabel(chat, topGainer.p)} (+${topGainer.delta} 🪙)`);
  }
  if (topLoser && topLoser.delta < 0) {
    footerSummary.push(`💸 Главный минус дня: ${playerLabel(chat, topLoser.p)} (${topLoser.delta} 🪙)`);
  }

  return [
    `🌙 ВЕЧЕРНЯЯ СВОДКА ДЯДИ ДЕПА (21:00)`,
    `📅 Статистика за последние сутки · «${chat.title}»`,
    ``,
    ...playerLines,
    ``,
    ...footerSummary,
    ``,
    `💬 ${nextPhrase(chat, 'leaderboardFooters')}`
  ].join('\n');
}

export async function sendDailyEveningReportBroadcast(
  transport: BotTransport,
  chatId: string,
  forceDate?: string
): Promise<boolean> {
  const db = getDb();
  const chat = db.chats[chatId];
  if (!chat || Object.keys(chat.players).length === 0) return false;

  const dateStr = forceDate || getZonedDateTimeParts().dateStr;
  const text = buildEveningSummaryText(chat);

  chat.lastEveningReportDate = dateStr;

  // Reset daily baselines right after capturing the 24h summary
  for (const player of Object.values(chat.players)) {
    player.dailyBaseline = createBaselineFromPlayer(player);
  }
  scheduleSave();

  addBotLog({
    source: 'scheduler',
    chatId: chat.chatId,
    chatTitle: chat.title,
    event: 'Рассылка 21:00 (Сутки)',
    detail: `Отправлена суточная сводка по ${Object.keys(chat.players).length} игрокам`
  });

  await transport.sendMessage(chat.chatId, text, [
    [{ text: '🎰 Открыть стол', callbackData: 'menu' }]
  ]);
  return true;
}

export async function handleCommand(
  transport: BotTransport,
  incomingChat: IncomingChat,
  incomingUser: IncomingUser,
  command: string
): Promise<void> {
  const { chat, player, isNew } = getOrCreatePlayer(
    incomingChat.chatId,
    incomingUser.userId,
    incomingUser.firstName,
    incomingUser.username,
    incomingChat.title,
    incomingChat.type
  );

  if (isNew) {
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'Новый игрок',
      detail: `Выдан стартовый баланс ${player.balance} фантиков`
    });
  }

  const cmd = command.split('@')[0].toLowerCase();
  if (cmd === '/start' || cmd === '/menu') {
    const prevMenuId = getPlayerActiveMenuMsgId(chat.chatId, player.userId);
    if (prevMenuId && !isProtectedInteractiveMessage(prevMenuId) && transport.deleteMessage) {
      await transport.deleteMessage(chat.chatId, prevMenuId);
    }
    const newMsgId = await transport.sendMessage(
      chat.chatId,
      buildMainMenuText(chat, player, 'home'),
      buildMainMenuKeyboard('home', getPlayerGameGenre(chat.chatId, player.userId), chat, player)
    );
    if (newMsgId) {
      setMessageOwner(chat.chatId, newMsgId, player.userId);
      setPlayerActiveMenuMsgId(chat.chatId, player.userId, newMsgId);
    }
    return;
  }
  if (cmd === '/top') {
    await transport.sendMessage(chat.chatId, buildLeaderboardText(chat), [
      [{ text: '🏠 В меню', callbackData: 'menu' }]
    ]);
    return;
  }
  if (cmd === '/me') {
    const view = buildProfileView(chat, player);
    const sentId = await transport.sendMessage(chat.chatId, view.text, view.keyboard);
    setMessageOwner(chat.chatId, sentId, player.userId);
  }
}

export async function handleTextMessage(
  transport: BotTransport,
  incomingChat: IncomingChat,
  incomingUser: IncomingUser,
  text: string,
  options?: { bypassCooldown?: boolean; forceTrigger?: boolean }
): Promise<boolean> {
  const { chat, player } = getOrCreatePlayer(
    incomingChat.chatId,
    incomingUser.userId,
    incomingUser.firstName,
    incomingUser.username,
    incomingChat.title,
    incomingChat.type
  );

  if (!text || text.startsWith('/')) return false;
  const matchedWord = findChatTriggerMatch(text);
  if (!matchedWord) return false;

  const now = Date.now();
  const onCooldown = !options?.bypassCooldown && now - chat.lastAutoChatReplyAt < CHAT_TRIGGER_COOLDOWN_MS;
  if (onCooldown) {
    const left = formatDuration(CHAT_TRIGGER_COOLDOWN_MS - (now - chat.lastAutoChatReplyAt));
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'Триггер чата (кулдаун)',
      detail: `Слово «${matchedWord}» — осталось ждать ${left}`
    });
    return false;
  }

  const roll = options?.forceTrigger ? 0 : Math.random();
  if (roll >= CHAT_TRIGGER_PROBABILITY) {
    const pct = Math.round(CHAT_TRIGGER_PROBABILITY * 100);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: `Триггер чата (пропуск)`,
      detail: `Слово «${matchedWord}» — не выпал шанс ${pct}%`
    });
    return false;
  }

  chat.lastAutoChatReplyAt = now;
  const quote = nextPhrase(chat, 'liveChatQuotes');
  scheduleSave();

  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: 'Реакция в живом чате',
    detail: `Услышал от ${displayName(player)} слово «${matchedWord}» → ответ Дяди Депа`
  });

  await transport.sendMessage(
    chat.chatId,
    `🧔‍♂️ Дядя Деп услышал от ${playerLabel(chat, player)} слово «${matchedWord}»:\n\n${quote}`,
    [[{ text: '🎰 Открыть стол', callbackData: 'menu' }]]
  );
  return true;
}

function isSharedOrMultiAction(parts: string[]): boolean {
  const action = parts[0];
  const sub = parts[1];
  if (action === 'cr' || action === 'rr' || action === 'bjt' || action === 'blz') return true;
  if (action === 'rc') return sub !== 'new';
  if (action === 'dl') return sub !== 'new';
  if (action === 'rps') return sub === 'pvpjoin' || sub === 'pmove' || sub === 'cancel';
  if (action === 'auc') return sub === 'bid' || sub === 'cancel' || sub === 'refresh';
  if (action === 'pot') {
    return (
      sub === 'bag' ||
      sub === 'toss' ||
      sub === 'addrand' ||
      sub === 'refresh' ||
      sub === 'spin' ||
      sub === 'cancel'
    );
  }
  if (action === 'ln') {
    return sub === 'fund' || sub === 'pay' || sub === 'rem' || sub === 'frg' || sub === 'cancel';
  }
  return false;
}

function isActiveSoloStepAction(parts: string[]): boolean {
  const action = parts[0];
  const sub = parts[1];
  if (action === 'mn') return sub !== 'cfg';
  if (action === 'dc' || action === 'bj' || action === 'hl' || action === 'th' || action === 'pn' || action === 'dp') {
    return true;
  }
  if (action === 'ldr') return sub !== 'cfg';
  if (action === 'rps') return sub === 'bpick';
  return false;
}

function createForkedPersonalTransport(
  base: BotTransport,
  chatId: string,
  userId: string,
  foreignMessageId: string,
  cleanupPrevMenuOnCreate: boolean
): BotTransport {
  let ownMessageId: string | null = null;
  let cleanedOldMenu = !cleanupPrevMenuOnCreate;

  const cleanupPreviousInactiveMenu = async () => {
    if (cleanedOldMenu) return;
    cleanedOldMenu = true;
    const prevMenuId = getPlayerActiveMenuMsgId(chatId, userId);
    if (
      prevMenuId &&
      prevMenuId !== foreignMessageId &&
      !isProtectedInteractiveMessage(prevMenuId) &&
      base.deleteMessage
    ) {
      await base.deleteMessage(chatId, prevMenuId);
    }
  };

  const recordOwnMsg = (sentId: string | null) => {
    if (!sentId) return;
    ownMessageId = sentId;
    setMessageOwner(chatId, sentId, userId);
    setPlayerActiveMenuMsgId(chatId, userId, sentId);
  };

  return {
    source: base.source,
    getRollDelayMs: () => base.getRollDelayMs(),
    answerCallback: (callbackId, text, showAlert) =>
      base.answerCallback(callbackId, text, showAlert),
    sendDice: (cId, emoji) => base.sendDice(cId, emoji),
    deleteMessage: base.deleteMessage
      ? (cId, mId) => base.deleteMessage!(cId, mId)
      : undefined,
    sendMessage: async (cId, text, keyboard) => {
      await cleanupPreviousInactiveMenu();
      const sentId = await base.sendMessage(cId, text, keyboard);
      if (cId === chatId && sentId) {
        if (!ownMessageId) {
          recordOwnMsg(sentId);
        } else {
          setMessageOwner(chatId, sentId, userId);
        }
      }
      return sentId;
    },
    editMessage: async (cId, targetMsgId, text, keyboard, options) => {
      // Allow updates targeting a DIFFERENT shared message (e.g. active Multiplayer Crash lobby)
      if (
        targetMsgId &&
        targetMsgId !== foreignMessageId &&
        targetMsgId !== ownMessageId
      ) {
        await base.editMessage(cId, targetMsgId, text, keyboard, options);
        return;
      }
      if (!ownMessageId) {
        await cleanupPreviousInactiveMenu();
        const sentId = await base.sendMessage(cId, text, keyboard);
        recordOwnMsg(sentId);
        return;
      }
      await base.editMessage(cId, ownMessageId, text, keyboard, options);
    }
  };
}

export async function handleCallback(
  rawTransport: BotTransport,
  incomingChat: IncomingChat,
  incomingUser: IncomingUser,
  callbackId: string,
  rawMessageId: string,
  data: string
): Promise<void> {
  const { chat, player } = getOrCreatePlayer(
    incomingChat.chatId,
    incomingUser.userId,
    incomingUser.firstName,
    incomingUser.username,
    incomingChat.title,
    incomingChat.type
  );

  const parts = data.split(':');
  const action = parts[0];

  let transport = rawTransport;
  let messageId = rawMessageId;

  if (messageId) {
    let ownerId = getMessageOwner(chat.chatId, messageId);
    if (incomingChat.type === 'private' && !ownerId) {
      setMessageOwner(chat.chatId, messageId, player.userId);
      ownerId = player.userId;
    }

    const isPersonalAction = !isSharedOrMultiAction(parts) && !isActiveSoloStepAction(parts);
    if (isPersonalAction && ownerId !== player.userId) {
      transport = createForkedPersonalTransport(
        rawTransport,
        chat.chatId,
        player.userId,
        messageId,
        action === 'menu'
      );
      messageId = '';
    }
  }

  // Main menu & section/genre switching (edits existing message instead of spamming)
  if (action === 'menu') {
    const subSection = parts[1];
    const subGenre = normalizeGameGenre(parts[2]);

    let section: MenuSection = 'home';
    let genre = getPlayerGameGenre(chat.chatId, player.userId);

    if (subSection === 'games') {
      section = 'games';
      if (subGenre) {
        genre = subGenre;
        setPlayerGameGenre(chat.chatId, player.userId, subGenre);
      }
    } else if (subSection === 'talismans') {
      section = 'talismans';
    } else if (subSection === 'profile') {
      section = 'profile';
    } else if (subSection === 'fast' || subSection === 'pvp' || subSection === 'skill') {
      section = 'games';
      genre = subSection;
      setPlayerGameGenre(chat.chatId, player.userId, subSection);
    }

    await transport.answerCallback(callbackId);
    const text = buildMainMenuText(chat, player, section, genre);
    const kb = buildMainMenuKeyboard(section, genre, chat, player);

    if (messageId && !isProtectedInteractiveMessage(messageId)) {
      setMessageOwner(chat.chatId, messageId, player.userId);
      setPlayerActiveMenuMsgId(chat.chatId, player.userId, messageId);
      await transport.editMessage(chat.chatId, messageId, text, kb);
    } else {
      const sentId = await transport.sendMessage(chat.chatId, text, kb);
      if (sentId) {
        setMessageOwner(chat.chatId, sentId, player.userId);
        setPlayerActiveMenuMsgId(chat.chatId, player.userId, sentId);
      }
    }
    return;
  }

  // Leaderboard (edits in place when clicked via inline button)
  if (action === 'top') {
    await transport.answerCallback(callbackId);
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, buildLeaderboardText(chat), [
        [{ text: '🏠 В меню', callbackData: 'menu' }]
      ]);
    } else {
      await transport.sendMessage(chat.chatId, buildLeaderboardText(chat), [
        [{ text: '🏠 В меню', callbackData: 'menu' }]
      ]);
    }
    return;
  }

  // Zero-balance bonus: step 1 — alert on block/cooldown, or edit in-place with Take button
  if (action === 'bonus') {
    if (player.balance > 0) {
      await transport.answerCallback(
        callbackId,
        `У тебя ещё ${player.balance} 🪙 на балансе! Бонус только при 0.`,
        true
      );
      return;
    }

    const elapsed = Date.now() - player.lastZeroBonusAt;
    if (player.lastZeroBonusAt > 0 && elapsed < ZERO_BONUS_COOLDOWN_MS) {
      const remaining = ZERO_BONUS_COOLDOWN_MS - elapsed;
      const waitStr = formatDuration(remaining);
      await transport.answerCallback(callbackId, `Рано! Следующий +${ZERO_BONUS_AMOUNT} через ${waitStr}`, true);
      return;
    }

    await transport.answerCallback(callbackId);
    await sendZeroBalanceOffer(transport, chat, player, messageId);
    return;
  }

  // Zero-balance bonus: step 2 — player explicitly clicks "Take 350 fantiks"
  if (action === 'bonus_take') {
    if (player.balance > 0) {
      await transport.answerCallback(callbackId, 'У тебя уже есть фантики на счету!', true);
      return;
    }

    const elapsed = Date.now() - player.lastZeroBonusAt;
    if (player.lastZeroBonusAt > 0 && elapsed < ZERO_BONUS_COOLDOWN_MS) {
      const remaining = ZERO_BONUS_COOLDOWN_MS - elapsed;
      const waitStr = formatDuration(remaining);
      await transport.answerCallback(callbackId, `Рано! Жди ещё ${waitStr}`, true);
      return;
    }

    player.balance += ZERO_BONUS_AMOUNT;
    player.lastZeroBonusAt = Date.now();
    player.stats.zeroBonusCount = (player.stats.zeroBonusCount || 0) + 1;
    scheduleSave();
    await transport.answerCallback(callbackId, `+${ZERO_BONUS_AMOUNT} фантиков начислено!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'Бонус при нуле (взят по кнопке)',
      detail: `+${ZERO_BONUS_AMOUNT} фантиков`
    });
    await transport.editMessage(
      chat.chatId,
      messageId,
      `${nextPhrase(chat, 'bonusGranted')}\n👤 Игрок: ${playerLabel(chat, player)}\n🪙 Новый баланс: ${player.balance} фантиков.`,
      buildMainMenuKeyboard('home', getPlayerGameGenre(chat.chatId, player.userId), chat, player)
    );
    return;
  }

  // Zero-balance bonus declined
  if (action === 'bonus_decline') {
    await transport.answerCallback(callbackId, 'Принято, кент.');
    await transport.editMessage(
      chat.chatId,
      messageId,
      `${nextPhrase(chat, 'bonusDeclined')}\n👤 Игрок: ${playerLabel(chat, player)} | 🪙 Баланс: ${player.balance}`,
      [
        [{ text: '🙏 Попросить в долг в чате', callbackData: 'ln:ask' }],
        [{ text: '🏠 В меню', callbackData: 'menu' }]
      ]
    );
    return;
  }

  // Select game -> choose stake (edits in-place, blocks via alert popup without spamming chat)
  if (action === 'g') {
    const game = parts[1] as GameType;
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      const wait = formatDuration(ghostMs);
      await transport.answerCallback(callbackId, `👻 Ты Призрак чата ещё ${wait}!`, true);
      return;
    }
    if (player.balance <= 0) {
      const elapsed = Date.now() - player.lastZeroBonusAt;
      if (player.lastZeroBonusAt > 0 && elapsed < ZERO_BONUS_COOLDOWN_MS) {
        const waitStr = formatDuration(ZERO_BONUS_COOLDOWN_MS - elapsed);
        await transport.answerCallback(
          callbackId,
          `На счету 0 🪙! Бонус +${ZERO_BONUS_AMOUNT} через ${waitStr}. Можно попросить в долг.`,
          true
        );
      } else {
        await transport.answerCallback(callbackId);
        await sendZeroBalanceOffer(transport, chat, player, messageId);
      }
      return;
    }
    await transport.answerCallback(callbackId);
    const text = [
      `${GAME_TITLES[game]}`,
      `ℹ️ ${GAME_RULES_SHORT[game]}`,
      ``,
      `👤 Игрок: ${playerLabel(chat, player)}`,
      `🪙 Твой баланс: ${player.balance} фантиков`,
      ``,
      `Выбери размер ставки:`
    ].join('\n');
    await transport.editMessage(chat.chatId, messageId, text, buildStakeKeyboard(game, player.balance));
    return;
  }

  // Stake selected OR Repeat OR Last Dodep
  if (action === 'b' || action === 'rep' || action === 'ld') {
    const game = parts[1] as GameType;
    const rawAmount = parts[2];
    const isLastDodep = action === 'ld';

    const resolved = resolveStakeAmount(player, rawAmount, isLastDodep);
    if (!resolved.ok) {
      if (resolved.reason === 'ZERO_BALANCE') {
        const elapsed = Date.now() - player.lastZeroBonusAt;
        if (player.lastZeroBonusAt > 0 && elapsed < ZERO_BONUS_COOLDOWN_MS) {
          const waitStr = formatDuration(ZERO_BONUS_COOLDOWN_MS - elapsed);
          await transport.answerCallback(
            callbackId,
            `На счету 0 🪙! Бонус +${ZERO_BONUS_AMOUNT} через ${waitStr}.`,
            true
          );
        } else {
          await transport.answerCallback(callbackId);
          await sendZeroBalanceOffer(transport, chat, player, messageId);
        }
      } else {
        await transport.answerCallback(callbackId, resolved.reason, true);
      }
      return;
    }

    const stake = resolved.amount;
    await transport.answerCallback(callbackId);
    await startGameFlow(transport, chat, player, game, stake, isLastDodep, messageId);
    return;
  }

  // Roulette outcome choice
  if (action === 'rl') {
    const choice = parts[1] as 'red' | 'blk' | 'zer';
    const stake = parseInt(parts[2], 10);
    const isLastDodep = parts[3] === '1';

    if (player.balance < stake || stake <= 0) {
      await transport.answerCallback(callbackId, 'Недостаточно фантиков!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `Призрак чата: жди ${formatDuration(ghostMs)}`, true);
      return;
    }

    await transport.answerCallback(callbackId, 'Шарик запущен!');
    await playRouletteSpin(transport, chat, player, messageId, stake, choice, isLastDodep);
    return;
  }

  // Multiplayer Crash actions
  if (action === 'cr') {
    await handleCrashCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Russian Roulette actions
  if (action === 'rr') {
    const sub = parts[1];
    const sid = parts[2];
    const lobby = russianLobbies.get(sid);
    if (!lobby) {
      await transport.answerCallback(callbackId, 'Лобби уже закрыто.', true);
      return;
    }

    if (sub === 'join') {
      if (lobby.status !== 'waiting') {
        await transport.answerCallback(callbackId, 'Игра уже началась!', true);
        return;
      }
      if (lobby.players.some((p) => p.userId === player.userId)) {
        await transport.answerCallback(callbackId, 'Ты уже в этом барабане!', true);
        return;
      }
      const ghostMs = getGhostRemainingMs(player);
      if (ghostMs > 0) {
        await transport.answerCallback(callbackId, `Ты Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
        return;
      }
      if (player.balance < lobby.stake) {
        await transport.answerCallback(callbackId, `Нужно ${lobby.stake} фантиков, у тебя ${player.balance}.`, true);
        return;
      }
      if (lobby.players.length >= 3) {
        await transport.answerCallback(callbackId, 'В лобби уже 3 смертника!', true);
        return;
      }

      deductPlayerStake(player, lobby.stake);
      lobby.players.push({ userId: player.userId, firstName: displayName(player), isLastDodep: false });
      scheduleSave();

      await transport.answerCallback(callbackId, 'Ты вписался в Русскую рулетку!');

      if (lobby.players.length === 3) {
        lobby.status = 'playing';
        await renderRussianRouletteState(transport, chat, lobby, messageId);
      } else {
        await renderRussianRouletteState(transport, chat, lobby, messageId);
      }
      return;
    }

    if (sub === 'go') {
      if (lobby.status !== 'waiting') {
        await transport.answerCallback(callbackId, 'Игра уже идёт!', true);
        return;
      }
      if (lobby.players.length < 2) {
        await transport.answerCallback(callbackId, 'Нужно минимум 2 игрока!', true);
        return;
      }
      lobby.status = 'playing';
      await transport.answerCallback(callbackId, 'Крутим барабан!');
      await renderRussianRouletteState(transport, chat, lobby, messageId);
      return;
    }

    if (sub === 'stop') {
      if (lobby.status !== 'waiting') {
        await transport.answerCallback(callbackId, 'Поздно отменять, курок на взводе!', true);
        return;
      }
      if (player.userId !== lobby.creatorId) {
        await transport.answerCallback(callbackId, 'Только создатель может закрыть лобби!', true);
        return;
      }
      // Refund everyone
      for (const p of lobby.players) {
        const ps = chat.players[p.userId];
        if (ps) ps.balance += lobby.stake;
      }
      lobby.status = 'finished';
      russianLobbies.delete(sid);
      scheduleSave();
      await transport.answerCallback(callbackId, 'Лобби отменено, ставки возвращены.');
      await transport.editMessage(
        chat.chatId,
        messageId,
        `🔫 Русская рулетка отменена создателем. Все ставки (${lobby.stake} фантиков) возвращены игрокам.`,
        [[{ text: '🏠 В меню', callbackData: 'menu' }]]
      );
      return;
    }

    if (sub === 'shot') {
      if (lobby.status !== 'playing') {
        await transport.answerCallback(callbackId, 'Раунд уже завершён.', true);
        return;
      }
      const currentShooter = lobby.players[lobby.turnIndex];
      if (currentShooter.userId !== player.userId) {
        await transport.answerCallback(callbackId, `Сейчас стреляет ${currentShooter.firstName}!`, true);
        return;
      }

      const isHit = lobby.chamber === lobby.bulletSlot;
      if (!isHit) {
        const safeLine = nextPhrase(chat, 'russianSafe');
        lobby.historyLines.push(`Слот ${lobby.chamber + 1}/6 (${currentShooter.firstName}): ${safeLine}`);
        lobby.chamber += 1;
        lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
        await transport.answerCallback(callbackId, 'Щёлк! Живой!');
        await renderRussianRouletteState(transport, chat, lobby, messageId);
        return;
      }

      // BANG! Loser gets Ghost status for 3 minutes, survivors split pot
      lobby.status = 'finished';
      russianLobbies.delete(sid);

      const pot = lobby.stake * lobby.players.length;
      const survivors = lobby.players.filter((p) => p.userId !== currentShooter.userId);
      const share = Math.floor(pot / survivors.length);

      const loserState = chat.players[currentShooter.userId];
      if (loserState) {
        loserState.ghostUntil = Date.now() + GHOST_DURATION_MS;
        loserState.stats.totalLost += lobby.stake;
        loserState.stats.ghostCount = (loserState.stats.ghostCount || 0) + 1;
        loserState.lastBetAmount = lobby.stake;
        loserState.lastGameType = 'russian';
        loserState.lastActionWasLoss = true;
        loserState.lastActionWasLastDodep = false;
        unlockAchievement(chat, loserState, 'ghost_walker');
        recordGameOutcome(chat, loserState, 'russian', -lobby.stake);
      }

      const survivorSummary: string[] = [];
      for (const s of survivors) {
        const st = chat.players[s.userId];
        if (st) {
          st.balance += share;
          st.stats.totalWon += share - lobby.stake;
          st.lastBetAmount = lobby.stake;
          st.lastGameType = 'russian';
          if (s.isLastDodep && st.lastActionWasLoss) {
            st.stats.lastDodepWins += 1;
          }
          st.lastActionWasLoss = false;
          st.lastActionWasLastDodep = false;
          unlockAchievement(chat, st, 'survivor');
          recordGameOutcome(chat, st, 'russian', share - lobby.stake, { isLastDodep: s.isLastDodep });
          survivorSummary.push(`${s.firstName} (+${share} 🪙)`);
        }
      }
      scheduleSave();

      await transport.answerCallback(callbackId, '💥 БАХ! Ты стал Призраком чата на 3 минуты!', true);
      addBotLog({
        source: transport.source,
        chatId: chat.chatId,
        chatTitle: chat.title,
        userName: currentShooter.firstName,
        event: 'Русская рулетка: БАХ',
        detail: `${currentShooter.firstName} → Призрак на 3 мин. Банк ${pot} поделён`
      });

      lobby.historyLines.push(`Слот ${lobby.chamber + 1}/6: ${currentShooter.firstName} — 💥 БАХ!`);

      const finalMsg = [
        `🔫 РУССКАЯ РУЛЕТКА — ФИНАЛ!`,
        `💰 Общий банк: ${pot} фантиков`,
        ``,
        ...lobby.historyLines,
        ``,
        `👻 ${currentShooter.firstName} получает статус «Призрак чата» на 3 минуты!`,
        `🏆 Выжившие делят банк: ${survivorSummary.join(', ')}`,
        ``,
        nextPhrase(chat, 'russianShot')
      ].join('\n');

      await transport.editMessage(
        chat.chatId,
        messageId,
        finalMsg,
        buildPostGameKeyboard('russian', lobby.stake, true)
      );
      for (const s of survivors) {
        const st = chat.players[s.userId];
        const net = share - lobby.stake;
        if (st && net > 0) {
          await applyAutoDebtCollection(transport, chat, st, net);
        }
      }
      if (loserState && loserState.balance === 0) {
        await maybeSendZeroBalanceOffer(transport, chat, loserState);
      }
      return;
    }
  }

  // Mines / Sapper actions
  if (action === 'mn') {
    const sub = parts[1];
    if (sub === 'cfg') {
      const bombs = parseInt(parts[2], 10);
      const stake = parseInt(parts[3], 10);
      const isLastDodep = parts[4] === '1';

      if (player.balance < stake || stake <= 0) {
        await transport.answerCallback(callbackId, 'Недостаточно фантиков!', true);
        return;
      }
      const ghostMs = getGhostRemainingMs(player);
      if (ghostMs > 0) {
        await transport.answerCallback(callbackId, `Призрак чата: жди ${formatDuration(ghostMs)}`, true);
        return;
      }

      deductPlayerStake(player, stake);
      scheduleSave();

      const mines = new Set<number>();
      while (mines.size < bombs) {
        mines.add(Math.floor(Math.random() * 25));
      }

      const sid = shortId();
      const session: MinesSession = {
        id: sid,
        chatId: chat.chatId,
        userId: player.userId,
        userName: displayName(player),
        stake,
        bombsCount: bombs,
        isLastDodep,
        mines,
        opened: new Set<number>(),
        status: 'playing',
        messageId: messageId || null,
        createdAt: Date.now()
      };
      minesSessions.set(sid, session);

      await transport.answerCallback(callbackId, `Поле ${bombs} мин готово!`);
      await renderMinesBoard(transport, chat, player, session, messageId, 'Выбирай безопасную клетку:');
      return;
    }

    if (sub === 'dig') {
      const sid = parts[2];
      const cell = parseInt(parts[3], 10);
      const session = minesSessions.get(sid);
      if (!session || session.status !== 'playing') {
        await transport.answerCallback(callbackId, 'Эта партия в Сапёра уже завершена.', true);
        return;
      }
      if (session.userId !== player.userId) {
        await transport.answerCallback(callbackId, 'Не лезь на чужое минное поле!', true);
        return;
      }
      if (session.opened.has(cell)) {
        await transport.answerCallback(callbackId, 'Клетка уже открыта!');
        return;
      }

      if (session.mines.has(cell)) {
        // Boom!
        session.status = 'busted';
        minesSessions.delete(sid);
        player.lastBetAmount = session.stake;
        player.lastGameType = 'mines';
        player.stats.totalLost += session.stake;
        player.lastActionWasLoss = true;
        player.lastActionWasLastDodep = false;
        recordGameOutcome(chat, player, 'mines', -session.stake, { isLastDodep: session.isLastDodep });
        scheduleSave();

        await transport.answerCallback(callbackId, '💥 БУМ! Мина!');
        addBotLog({
          source: transport.source,
          chatId: chat.chatId,
          chatTitle: chat.title,
          userName: session.userName,
          event: `Мины (${session.bombsCount}): Взрыв`,
          detail: `Потеряно ${session.stake} фантиков на шаге ${session.opened.size + 1}`
        });

        await renderMinesFinished(transport, chat, player, session, messageId, cell, false);
        return;
      }

      // Safe cell!
      session.opened.add(cell);
      const safeTotal = 25 - session.bombsCount;
      if (session.opened.size >= safeTotal) {
        // Cleared all safe cells! Auto cashout
        await cashoutMines(transport, chat, player, session, callbackId, messageId);
        return;
      }

      const mult = calcMinesMultiplier(session.bombsCount, session.opened.size);
      await transport.answerCallback(callbackId, `💎 Чисто! Текущий икс: x${mult.toFixed(2)}`);
      await renderMinesBoard(transport, chat, player, session, messageId, nextPhrase(chat, 'minesSafe'));
      return;
    }

    if (sub === 'cash') {
      const sid = parts[2];
      const session = minesSessions.get(sid);
      if (!session || session.status !== 'playing') {
        await transport.answerCallback(callbackId, 'Игра уже завершена.', true);
        return;
      }
      if (session.userId !== player.userId) {
        await transport.answerCallback(callbackId, 'Это не твоё поле!', true);
        return;
      }
      if (session.opened.size === 0) {
        await transport.answerCallback(callbackId, 'Открой хотя бы 1 клетку!', true);
        return;
      }
      await cashoutMines(transport, chat, player, session, callbackId, messageId);
      return;
    }

    if (sub === 'stop') {
      const sid = parts[2];
      const session = minesSessions.get(sid);
      if (!session || session.status !== 'playing') {
        await transport.answerCallback(callbackId, 'Игра уже завершена.', true);
        return;
      }
      if (session.userId !== player.userId) {
        await transport.answerCallback(callbackId, 'Это не твоё поле!', true);
        return;
      }
      if (session.opened.size > 0) {
        await cashoutMines(transport, chat, player, session, callbackId, messageId);
        return;
      }
      // Refund if 0 tiles opened
      session.status = 'cashed';
      minesSessions.delete(sid);
      player.balance += session.stake;
      scheduleSave();
      await transport.answerCallback(callbackId, 'Ставка возвращена.');
      await transport.editMessage(
        chat.chatId,
        messageId,
        `💣 Мины: ${session.userName} передумал ступать на поле. Ставка ${session.stake} фантиков возвращена.`,
        [[{ text: '🏠 В меню', callbackData: 'menu' }]]
      );
      return;
    }
  }

  // Dice player roll
  if (action === 'dc' && parts[1] === 'roll') {
    const sid = parts[2];
    const session = diceSessions.get(sid);
    if (!session || session.status !== 'waiting_player') {
      await transport.answerCallback(callbackId, 'Этот бросок уже сыгран.', true);
      return;
    }
    if (session.userId !== player.userId) {
      await transport.answerCallback(callbackId, 'Это дуэль другого философа!', true);
      return;
    }

    session.status = 'rolling';
    await transport.answerCallback(callbackId, 'Бросаем твой кубик!');

    await transport.editMessage(
      chat.chatId,
      messageId,
      [
        `🎲 КОСТИ ПРОТИВ ДЯДИ ДЕПА`,
        `👤 Игрок: ${session.userName} | Ставка: ${session.stake} 🪙`,
        `🧔‍♂️ Дядя Деп выбросил: ${session.botRoll}`,
        `⏳ Твой кубик катится по сукну...`
      ].join('\n')
    );

    const diceRes = await transport.sendDice(chat.chatId);
    const delay = transport.getRollDelayMs();
    if (delay > 0) await sleep(delay);
    scheduleCleanupMessage(transport, chat.chatId, diceRes.messageId, 8000);

    const playerRoll = diceRes.value;
    session.status = 'finished';
    diceSessions.delete(sid);

    player.lastBetAmount = session.stake;
    player.lastGameType = 'dice';

    let resultHeader = '';
    let comment = '';
    let wasLoss = false;

    if (playerRoll > session.botRoll) {
      const payout = session.stake * 2;
      player.balance += payout;
      player.stats.totalWon += session.stake;
      if (session.isLastDodep && player.lastActionWasLoss) {
        player.stats.lastDodepWins += 1;
      }
      player.lastActionWasLoss = false;
      player.lastActionWasLastDodep = false;
      resultHeader = `🏆 ПОБЕДА! Забираешь ${payout} фантиков (x2)!`;
      comment = nextPhrase(chat, 'diceWin');
    } else if (playerRoll < session.botRoll) {
      player.stats.totalLost += session.stake;
      player.lastActionWasLoss = true;
      player.lastActionWasLastDodep = false;
      wasLoss = true;
      resultHeader = `💀 ПРОИГРЫШ! Ставка ${session.stake} фантиков ушла в банк стола.`;
      comment = nextPhrase(chat, 'diceLoss');
    } else {
      player.balance += session.stake;
      player.lastActionWasLoss = false;
      player.lastActionWasLastDodep = false;
      resultHeader = `🤝 НИЧЬЯ! Ставка ${session.stake} фантиков возвращена.`;
      comment = nextPhrase(chat, 'diceDraw');
    }

    const netDice = playerRoll > session.botRoll ? session.stake : playerRoll < session.botRoll ? -session.stake : 0;
    recordGameOutcome(chat, player, 'dice', netDice, { isLastDodep: session.isLastDodep });
    scheduleSave();
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: session.userName,
      event: `Кости: ${playerRoll} vs ${session.botRoll}`,
      detail: wasLoss ? `Проигрыш ${session.stake}` : playerRoll === session.botRoll ? 'Ничья' : `Победа x2 (${session.stake * 2})`
    });

    const finalMsg = [
      `🎲 КОСТИ ПРОТИВ ДЯДИ ДЕПА — ИТОГ`,
      `👤 Игрок: ${session.userName} (${playerRoll}) vs 🧔‍♂️ Дядя Деп (${session.botRoll})`,
      resultHeader,
      `🪙 Баланс: ${player.balance} фантиков`,
      ``,
      comment
    ].join('\n');

    await transport.editMessage(
      chat.chatId,
      messageId,
      finalMsg,
      buildPostGameKeyboard('dice', session.stake, wasLoss, player)
    );
    if (playerRoll > session.botRoll) {
      await applyAutoDebtCollection(transport, chat, player, session.stake);
    }
    return;
  }

  // Blackjack actions (hit / stand / double)
  if (action === 'bj') {
    const sub = parts[1];
    const sid = parts[2];
    const session = blackjackSessions.get(sid);
    if (!session || session.status !== 'playing') {
      await transport.answerCallback(callbackId, 'Эта раздача уже завершена.', true);
      return;
    }
    if (session.userId !== player.userId) {
      await transport.answerCallback(callbackId, 'Не лезь в чужую раздачу, кент!', true);
      return;
    }

    if (sub === 'hit') {
      const card = session.deck.pop();
      if (card) session.playerHand.push(card);
      const score = calcBlackjackScore(session.playerHand);

      if (score > 21) {
        await transport.answerCallback(callbackId, `Перебор (${score})!`);
        await finishBlackjackRound(transport, chat, player, session, messageId, false);
        return;
      }

      if (score === 21) {
        await transport.answerCallback(callbackId, 'Ровно 21! Ход переходит к Дяде Депу.');
        await finishBlackjackRound(transport, chat, player, session, messageId, true);
        return;
      }

      await transport.answerCallback(callbackId, `Выпало ${card?.rank}${card?.suit} (итого ${score})`);
      await renderBlackjackPlaying(transport, player, session, messageId);
      return;
    }

    if (sub === 'stand') {
      await transport.answerCallback(callbackId, 'Стоп! Дядя Деп добирает карты...');
      await finishBlackjackRound(transport, chat, player, session, messageId, true);
      return;
    }

    if (sub === 'dbl') {
      if (session.playerHand.length !== 2) {
        await transport.answerCallback(callbackId, 'Удвоить можно только на первых двух картах!', true);
        return;
      }
      if (player.balance < session.stake) {
        await transport.answerCallback(callbackId, `Не хватает фантиков для удвоения (нужно ${session.stake})!`, true);
        return;
      }

      if (session.stake > 0 && session.stake >= player.balance) {
        player.stats.allInCount = (player.stats.allInCount || 0) + 1;
      }
      player.balance -= session.stake;
      session.stake *= 2;
      session.doubled = true;
      scheduleSave();

      const card = session.deck.pop();
      if (card) session.playerHand.push(card);
      const score = calcBlackjackScore(session.playerHand);

      await transport.answerCallback(callbackId, `Удвоение! Карта ${card?.rank}${card?.suit} (итого ${score})`);
      await finishBlackjackRound(transport, chat, player, session, messageId, score <= 21);
      return;
    }
  }

  // Plinko drop
  if (action === 'pl' && parts[1] === 'go') {
    const risk = parts[2] as 'low' | 'med' | 'high';
    const stake = parseInt(parts[3], 10);
    const isLastDodep = parts[4] === '1';

    if (player.balance < stake || stake <= 0) {
      await transport.answerCallback(callbackId, 'Недостаточно фантиков!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `Призрак чата: жди ${formatDuration(ghostMs)}`, true);
      return;
    }

    await transport.answerCallback(callbackId, 'Шарик полетел по штырькам!');
    await playPlinkoDrop(transport, chat, player, messageId, stake, risk, isLastDodep);
    return;
  }

  // Cockroach Races actions
  if (action === 'rc') {
    await handleRaceCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Hi-Lo actions
  if (action === 'hl') {
    await handleHiloCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // P2P Loans ("Пацанский общак")
  if (action === 'ln') {
    await handleLoanCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Talismans & Cases ("Шкатулка и кейсы")
  if (action === 'tl') {
    await handleTalismanCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Duel 1v1 ("Орёл и Решка PvP")
  if (action === 'dl') {
    await handleDuelCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Ladder / Tower ("Лесенка додепа")
  if (action === 'ldr') {
    await handleLadderCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Common Pot ("Общий Котёл Талисманов")
  if (action === 'pot') {
    await handlePotCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Thimbles ("Напёрстки")
  if (action === 'th') {
    await handleThimblesCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Rock Paper Scissors ("К-Н-Б")
  if (action === 'rps') {
    await handleRpsCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Penalty ("Пенальти")
  if (action === 'pn') {
    await handlePenaltyCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Dice Poker ("Покер на костях")
  if (action === 'dp') {
    await handleDicePokerCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Evening Lottery ("Лотерея 20:55")
  if (action === 'lot') {
    await handleLotteryCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Daily Quests ("Дейлики")
  if (action === 'dq') {
    await handleDailyQuestsCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Profile & Achievements ("/me")
  if (action === 'me') {
    await handleProfileCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Talisman Auction ("Аукцион реликвий")
  if (action === 'auc') {
    await handleAuctionCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Multiplayer Blackjack Table ("Стол 21 на 2–4 игроков")
  if (action === 'bjt') {
    await handleMultiBlackjackCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  // Chat Blitz ("Блиц от Дяди Депа")
  if (action === 'blz') {
    await handleBlitzCallback(transport, chat, player, callbackId, messageId, parts);
    return;
  }

  await transport.answerCallback(callbackId);
}

async function startGameFlow(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  game: GameType,
  stake: number,
  isLastDodep: boolean,
  messageId?: string
): Promise<void> {
  const ldFlag = isLastDodep ? '1' : '0';
  const sendOrEdit = async (text: string, kb?: InlineKeyboard): Promise<string | null> => {
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, text, kb);
      return messageId;
    }
    return transport.sendMessage(chat.chatId, text, kb);
  };

  if (game === 'roulette') {
    const text = [
      `🎡 ТЕКСТОВАЯ РУЛЕТКА`,
      `👤 Игрок: ${playerLabel(chat, player)} | Ставка: ${stake} фантиков`,
      ``,
      `Выбери исход:`,
      `• 🔴 Красное — x2`,
      `• ⚫ Чёрное — x2`,
      `• 🟢 Зеро (0) — x14`
    ].join('\n');
    const kb: InlineKeyboard = [
      [
        { text: '🔴 Красное (x2)', callbackData: `rl:red:${stake}:${ldFlag}` },
        { text: '⚫ Чёрное (x2)', callbackData: `rl:blk:${stake}:${ldFlag}` }
      ],
      [{ text: '🟢 Зеро (x14)', callbackData: `rl:zer:${stake}:${ldFlag}` }],
      [{ text: '↩️ Назад в меню', callbackData: 'menu' }]
    ];
    await sendOrEdit(text, kb);
    return;
  }

  if (game === 'crash') {
    await startOrJoinMultiplayerCrash(transport, chat, player, stake, isLastDodep, messageId);
    return;
  }

  if (game === 'thimbles') {
    await startThimblesGame(transport, chat, player, stake, isLastDodep, messageId);
    return;
  }

  if (game === 'rps') {
    await startRpsMenu(transport, chat, player, stake, isLastDodep, messageId);
    return;
  }

  if (game === 'penalty') {
    await startPenaltyGame(transport, chat, player, stake, isLastDodep, messageId);
    return;
  }

  if (game === 'dicepoker') {
    await startDicePokerGame(transport, chat, player, stake, isLastDodep, messageId);
    return;
  }

  if (game === 'bjtable') {
    await startMultiBlackjackLobby(transport, chat, player, stake, isLastDodep, messageId);
    return;
  }

  if (game === 'russian') {
    deductPlayerStake(player, stake);
    scheduleSave();

    const sid = shortId();
    const lobby: RussianLobby = {
      id: sid,
      chatId: chat.chatId,
      stake,
      creatorId: player.userId,
      players: [{ userId: player.userId, firstName: displayName(player), isLastDodep }],
      status: 'waiting',
      chamber: 0,
      bulletSlot: Math.floor(Math.random() * 6),
      turnIndex: 0,
      messageId: messageId || null,
      historyLines: [],
      transportSource: transport.source,
      transport,
      createdAt: Date.now()
    };
    russianLobbies.set(sid, lobby);
    markRuntimeDirty();
    await renderRussianRouletteState(transport, chat, lobby, messageId || null);
    return;
  }

  if (game === 'mines') {
    const text = [
      `💣 МИНЫ / САПЁР (СЕТКА 5×5)`,
      `👤 Игрок: ${playerLabel(chat, player)} | Ставка: ${stake} фантиков`,
      ``,
      `Сколько мин спрятать на поле?`
    ].join('\n');
    const kb: InlineKeyboard = [
      [
        { text: '💣 3 мины (спокойно)', callbackData: `mn:cfg:3:${stake}:${ldFlag}` },
        { text: '💣 5 мин (баланс)', callbackData: `mn:cfg:5:${stake}:${ldFlag}` }
      ],
      [{ text: '💣 7 мин (для титанов)', callbackData: `mn:cfg:7:${stake}:${ldFlag}` }],
      [{ text: '↩️ В меню', callbackData: 'menu' }]
    ];
    await sendOrEdit(text, kb);
    return;
  }

  if (game === 'dice') {
    deductPlayerStake(player, stake);
    scheduleSave();

    const panelId = await sendOrEdit(
      `🎲 КОСТИ (ДОГОН)\n👤 ${playerLabel(chat, player)} ставит ${stake} фантиков!\n🧔‍♂️ Дядя Деп кидает свой кубик...`
    );

    const botDice = await transport.sendDice(chat.chatId);
    const delay = transport.getRollDelayMs();
    if (delay > 0) await sleep(delay);
    scheduleCleanupMessage(transport, chat.chatId, botDice.messageId, 8000);

    const sid = shortId();
    const session: DiceSession = {
      id: sid,
      chatId: chat.chatId,
      userId: player.userId,
      userName: displayName(player),
      stake,
      isLastDodep,
      botRoll: botDice.value,
      status: 'waiting_player',
      messageId: panelId,
      createdAt: Date.now()
    };
    diceSessions.set(sid, session);

    const waitingText = [
      `🎲 КОСТИ ПРОТИВ ДЯДИ ДЕПА`,
      `👤 Игрок: ${session.userName} | Ставка: ${stake} 🪙`,
      `🧔‍♂️ Дядя Деп выбросил: ${botDice.value}`,
      ``,
      `Твоя очередь! Жми кнопку для ответного броска:`
    ].join('\n');
    const waitingKb: InlineKeyboard = [[{ text: '🎲 Бросить в ответ!', callbackData: `dc:roll:${sid}` }]];

    if (panelId) {
      await transport.editMessage(chat.chatId, panelId, waitingText, waitingKb);
    } else {
      session.messageId = await transport.sendMessage(chat.chatId, waitingText, waitingKb);
    }
    return;
  }

  if (game === 'blackjack') {
    deductPlayerStake(player, stake);
    scheduleSave();

    const deck = createShuffledDeck();
    const playerHand = [deck.pop()!, deck.pop()!];
    const dealerHand = [deck.pop()!, deck.pop()!];
    const pScore = calcBlackjackScore(playerHand);
    const dScore = calcBlackjackScore(dealerHand);

    // Check immediate natural 21
    if (pScore === 21 || dScore === 21) {
      player.lastBetAmount = stake;
      player.lastGameType = 'blackjack';

      let resultHeader = '';
      let comment = '';
      let wasLoss = false;

      if (pScore === 21 && dScore !== 21) {
        const payout = Math.round(stake * 2.5);
        player.balance += payout;
        player.stats.totalWon += payout - stake;
        if (isLastDodep && player.lastActionWasLoss) {
          player.stats.lastDodepWins += 1;
        }
        player.lastActionWasLoss = false;
        player.lastActionWasLastDodep = false;
        resultHeader = `🔥 НАТУРАЛЬНЫЙ БЛЭКДЖЕК (x2.5)! Выигрыш: +${payout} фантиков!`;
        comment = nextPhrase(chat, 'blackjackNatural');
        addBotLog({
          source: transport.source,
          chatId: chat.chatId,
          chatTitle: chat.title,
          userName: displayName(player),
          event: 'Блэкджек: 21 с раздачи (x2.5)',
          detail: `Ставка ${stake} → Выигрыш ${payout}`
        });
      } else if (dScore === 21 && pScore !== 21) {
        player.stats.totalLost += stake;
        player.lastActionWasLoss = true;
        player.lastActionWasLastDodep = false;
        wasLoss = true;
        resultHeader = `💀 У ДЯДИ ДЕПА БЛЭКДЖЕК С РАЗДАЧИ (21)! Сгорело ${stake} фантиков.`;
        comment = nextPhrase(chat, 'blackjackLoss');
        addBotLog({
          source: transport.source,
          chatId: chat.chatId,
          chatTitle: chat.title,
          userName: displayName(player),
          event: 'Блэкджек: 21 у дилера',
          detail: `Потеряно ${stake} фантиков`
        });
      } else {
        player.balance += stake;
        player.lastActionWasLoss = false;
        player.lastActionWasLastDodep = false;
        resultHeader = `🤝 ДВОЙНОЙ БЛЭКДЖЕК (21 vs 21)! Ничья — ставка ${stake} 🪙 возвращена.`;
        comment = nextPhrase(chat, 'blackjackDraw');
        addBotLog({
          source: transport.source,
          chatId: chat.chatId,
          chatTitle: chat.title,
          userName: displayName(player),
          event: 'Блэкджек: Ничья 21:21',
          detail: `Возврат ${stake}`
        });
      }

      const netNatural = pScore === 21 && dScore !== 21 ? Math.round(stake * 2.5) - stake : dScore === 21 && pScore !== 21 ? -stake : 0;
      recordGameOutcome(chat, player, 'blackjack', netNatural, { isLastDodep });
      scheduleSave();
      const text = [
        `🃏 БЛЭКДЖЕК (21) — ИТОГ С РАЗДАЧИ`,
        `👤 Игрок: ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
        ``,
        `🙋 Твои карты (${pScore}): ${formatBlackjackHand(playerHand)}`,
        `🧔‍♂️ Дядя Деп (${dScore}): ${formatBlackjackHand(dealerHand)}`,
        ``,
        resultHeader,
        `🪙 Баланс: ${player.balance} фантиков`,
        ``,
        comment
      ].join('\n');

      await sendOrEdit(text, buildPostGameKeyboard('blackjack', stake, wasLoss, player));
      if (pScore === 21 && dScore !== 21) {
        await applyAutoDebtCollection(transport, chat, player, Math.round(stake * 2.5) - stake);
      }
      return;
    }

    const sid = shortId();
    const session: BlackjackSession = {
      id: sid,
      chatId: chat.chatId,
      userId: player.userId,
      userName: displayName(player),
      stake,
      isLastDodep,
      deck,
      playerHand,
      dealerHand,
      doubled: false,
      status: 'playing',
      messageId: messageId || null,
      createdAt: Date.now()
    };
    blackjackSessions.set(sid, session);
    await renderBlackjackPlaying(transport, player, session, messageId || null);
    return;
  }

  if (game === 'plinko') {
    const text = [
      `🔺 ПЛИНКО · ВЫБОР РИСКА`,
      `👤 Игрок: ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
      ``,
      `6 рядов штырьков → 7 луз. Выбирай режим броска:`,
      ``,
      `🟢 Низкий (сейв):`,
      `x2.4 · x1.4 · x1.1 · x0.4 · x1.1 · x1.4 · x2.4`,
      ``,
      `🟡 Средний (баланс):`,
      `x4.5 · x1.8 · x0.9 · x0.25 · x0.9 · x1.8 · x4.5`,
      ``,
      `🔴 Высокий (охота за x12):`,
      `x12 · x1.8 · x0.5 · x0.1 · x0.5 · x1.8 · x12`
    ].join('\n');
    const kb: InlineKeyboard = [
      [{ text: '🟢 Низкий риск (до x2.4)', callbackData: `pl:go:low:${stake}:${ldFlag}` }],
      [{ text: '🟡 Средний риск (до x4.5)', callbackData: `pl:go:med:${stake}:${ldFlag}` }],
      [{ text: '🔴 Высокий риск (до x12)', callbackData: `pl:go:high:${stake}:${ldFlag}` }],
      [{ text: '↩️ В меню', callbackData: 'menu' }]
    ];
    await sendOrEdit(text, kb);
    return;
  }

  if (game === 'races') {
    const text = [
      `🪳 ТАРАКАНЬИ БЕГА — ВЫБОР БОЙЦА`,
      `👤 Создаёт забег: ${playerLabel(chat, player)} | Ставка входа: ${stake} 🪙`,
      ``,
      `На кого ставишь и открываешь дорожку для всего чата?`
    ].join('\n');
    const kb: InlineKeyboard = [
      [
        { text: '🪳 Виталя', callbackData: `rc:new:0:${stake}:${ldFlag}` },
        { text: '🐌 Тормоз', callbackData: `rc:new:1:${stake}:${ldFlag}` }
      ],
      [
        { text: '🐀 Крысюк', callbackData: `rc:new:2:${stake}:${ldFlag}` },
        { text: '🦀 Олигарх', callbackData: `rc:new:3:${stake}:${ldFlag}` }
      ],
      [{ text: '↩️ В меню', callbackData: 'menu' }]
    ];
    await sendOrEdit(text, kb);
    return;
  }

  if (game === 'slots') {
    await playSlot777(transport, chat, player, stake, isLastDodep, messageId);
    return;
  }

  if (game === 'hilo') {
    deductPlayerStake(player, stake);
    scheduleSave();

    const deck = createShuffledHiloDeck();
    const firstCard = deck.pop()!;
    const sid = shortId();
    const session: HiloSession = {
      id: sid,
      chatId: chat.chatId,
      userId: player.userId,
      userName: displayName(player),
      stake,
      isLastDodep,
      deck,
      currentCard: firstCard,
      trail: [firstCard],
      currentMult: 1.0,
      streak: 0,
      status: 'playing',
      messageId: messageId || null,
      createdAt: Date.now()
    };
    hiloSessions.set(sid, session);
    await renderHiloState(transport, chat, player, session, messageId || null, 'Угадай, какая карта выйдет следующей:');
    return;
  }

  if (game === 'duel') {
    const text = [
      `🪙 ДУЭЛЬ 1 НА 1 (ОРЁЛ И РЕШКА)`,
      `⚔️ Вызов бросает: ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
      `💰 Победитель забирает банк целиком: ${stake * 2} 🪙!`,
      ``,
      `Выбери свою сторону монеты:`
    ].join('\n');
    const kb: InlineKeyboard = [
      [
        { text: '🦅 Ставлю на Орла', callbackData: `dl:new:heads:${stake}:${ldFlag}` },
        { text: '🪙 Ставлю на Решку', callbackData: `dl:new:tails:${stake}:${ldFlag}` }
      ],
      [{ text: '↩️ В меню', callbackData: 'menu' }]
    ];
    await sendOrEdit(text, kb);
    return;
  }

  if (game === 'ladder') {
    const text = [
      `🪜 ЛЕСЕНКА ДОДЕПА (БАШНЯ 6 ЭТАЖЕЙ)`,
      `👤 Альпинист: ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
      ``,
      `На каждом этаже 3 двери. Выбирай режим:`,
      `• 🟢 Лайт (2 сейфа, 1 капкан): x1.44 → x2.16 → x3.24 → x4.86 → x7.29 → x10.94`,
      `• 🔴 Хардкор (1 сейф, 2 капкана): x2.88 → x8.64 → x25.9 → x77.8 → x233 → x699.8`
    ].join('\n');
    const kb: InlineKeyboard = [
      [{ text: '🟢 Лайт (2/3 двери · до x10.94)', callbackData: `ldr:cfg:easy:${stake}:${ldFlag}` }],
      [{ text: '🔴 Хардкор (1/3 дверь · до x699.84)', callbackData: `ldr:cfg:hard:${stake}:${ldFlag}` }],
      [{ text: '↩️ В меню', callbackData: 'menu' }]
    ];
    await sendOrEdit(text, kb);
  }
}

function buildBlackjackPlayingPayload(player: PlayerState, session: BlackjackSession) {
  const pScore = calcBlackjackScore(session.playerHand);
  const dealerVisible = session.dealerHand[0];
  const dealerVisibleVal = dealerVisible.rank === 'A' ? 11 : dealerVisible.value;

  const text = [
    `🃏 БЛЭКДЖЕК (21) ПРОТИВ ДЯДИ ДЕПА`,
    `👤 Игрок: ${session.userName} | Ставка: ${session.stake} 🪙`,
    ``,
    `🙋 Твои карты (${pScore}): ${formatBlackjackHand(session.playerHand)}`,
    `🧔‍♂️ Дядя Деп (${dealerVisibleVal}+?): [${dealerVisible.rank}${dealerVisible.suit}] 🂠`,
    ``,
    `Твой ход: добрать карту или остановиться?`
  ].join('\n');

  const row1: InlineButton[] = [
    { text: '🃏 Ещё карту', callbackData: `bj:hit:${session.id}` },
    { text: '✋ Хватит', callbackData: `bj:stand:${session.id}` }
  ];
  const kb: InlineKeyboard = [row1];
  if (session.playerHand.length === 2 && player.balance >= session.stake) {
    kb.push([{ text: `⚡ Удвоить (+${session.stake} 🪙)`, callbackData: `bj:dbl:${session.id}` }]);
  }
  return { text, kb };
}

async function renderBlackjackPlaying(
  transport: BotTransport,
  player: PlayerState,
  session: BlackjackSession,
  existingMsgId: string | null
): Promise<void> {
  const { text, kb } = buildBlackjackPlayingPayload(player, session);
  if (existingMsgId) {
    await transport.editMessage(chatIdFromSession(session), existingMsgId, text, kb);
  } else {
    session.messageId = await transport.sendMessage(session.chatId, text, kb);
  }
}

function chatIdFromSession(session: { chatId: string }): string {
  return session.chatId;
}

async function finishBlackjackRound(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  session: BlackjackSession,
  messageId: string,
  dealerShouldDraw: boolean
): Promise<void> {
  session.status = 'finished';
  blackjackSessions.delete(session.id);

  if (dealerShouldDraw) {
    while (calcBlackjackScore(session.dealerHand) < 17) {
      const nextCard = session.deck.pop();
      if (!nextCard) break;
      session.dealerHand.push(nextCard);
    }
  }

  const pScore = calcBlackjackScore(session.playerHand);
  const dScore = calcBlackjackScore(session.dealerHand);

  player.lastBetAmount = session.stake;
  player.lastGameType = 'blackjack';

  let resultHeader = '';
  let comment = '';
  let wasLoss = false;
  let logDetail = '';

  if (pScore > 21) {
    player.stats.totalLost += session.stake;
    player.lastActionWasLoss = true;
    player.lastActionWasLastDodep = false;
    wasLoss = true;
    resultHeader = `💥 ПЕРЕБОР (${pScore})! Сгорело ${session.stake} фантиков.`;
    comment = nextPhrase(chat, 'blackjackLoss');
    logDetail = `Перебор ${pScore} → Проигрыш ${session.stake}`;
  } else if (dScore > 21 || pScore > dScore) {
    const payout = session.stake * 2;
    player.balance += payout;
    player.stats.totalWon += session.stake;
    if (session.isLastDodep && player.lastActionWasLoss) {
      player.stats.lastDodepWins += 1;
    }
    player.lastActionWasLoss = false;
    player.lastActionWasLastDodep = false;
    resultHeader =
      dScore > 21
        ? `🏆 У ДЯДИ ДЕПА ПЕРЕБОР (${dScore})! Забираешь ${payout} фантиков (x2)!`
        : `🏆 ПОБЕДА (${pScore} vs ${dScore})! Забираешь ${payout} фантиков (x2)!`;
    comment = nextPhrase(chat, 'blackjackWin');
    logDetail = `Победа ${pScore}:${dScore} → +${payout}`;
  } else if (pScore < dScore) {
    player.stats.totalLost += session.stake;
    player.lastActionWasLoss = true;
    player.lastActionWasLastDodep = false;
    wasLoss = true;
    resultHeader = `💀 ПРОИГРЫШ (${pScore} vs ${dScore})! Ставка ${session.stake} фантиков ушла в банк стола.`;
    comment = nextPhrase(chat, 'blackjackLoss');
    logDetail = `Проигрыш ${pScore}:${dScore} (-${session.stake})`;
  } else {
    player.balance += session.stake;
    player.lastActionWasLoss = false;
    player.lastActionWasLastDodep = false;
    resultHeader = `🤝 НИЧЬЯ (${pScore} vs ${dScore})! Ставка ${session.stake} фантиков возвращена.`;
    comment = nextPhrase(chat, 'blackjackDraw');
    logDetail = `Ничья ${pScore}:${dScore} (возврат ${session.stake})`;
  }

  const bjNet = pScore > 21 ? -session.stake : dScore > 21 || pScore > dScore ? session.stake : pScore < dScore ? -session.stake : 0;
  recordGameOutcome(chat, player, 'blackjack', bjNet, { isLastDodep: session.isLastDodep });
  scheduleSave();
  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: session.userName,
    event: `Блэкджек: ${pScore} vs ${dScore}`,
    detail: logDetail
  });

  const finalMsg = [
    `🃏 БЛЭКДЖЕК (21) — ИТОГ${session.doubled ? ' (УДВОЕНО)' : ''}`,
    `👤 Игрок: ${session.userName} | Ставка: ${session.stake} 🪙`,
    ``,
    `🙋 Твои карты (${pScore}): ${formatBlackjackHand(session.playerHand)}`,
    `🧔‍♂️ Дядя Деп (${dScore}): ${formatBlackjackHand(session.dealerHand)}`,
    ``,
    resultHeader,
    `🪙 Баланс: ${player.balance} фантиков`,
    ``,
    comment
  ].join('\n');

  await transport.editMessage(
    chat.chatId,
    messageId,
    finalMsg,
    buildPostGameKeyboard('blackjack', session.stake, wasLoss, player)
  );
  if (pScore <= 21 && (dScore > 21 || pScore > dScore)) {
    await applyAutoDebtCollection(transport, chat, player, session.stake);
  }
}

async function playRouletteSpin(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  messageId: string,
  stake: number,
  choice: 'red' | 'blk' | 'zer',
  isLastDodep: boolean
): Promise<void> {
  deductPlayerStake(player, stake);
  scheduleSave();

  const choiceLabel = choice === 'red' ? '🔴 Красное (x2)' : choice === 'blk' ? '⚫ Чёрное (x2)' : '🟢 Зеро (x14)';

  const redNumbers = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const rolledNum = Math.floor(Math.random() * 37);
  const rolledColor: 'red' | 'blk' | 'zer' =
    rolledNum === 0 ? 'zer' : redNumbers.has(rolledNum) ? 'red' : 'blk';
  const rolledEmoji = rolledColor === 'zer' ? '🟢' : rolledColor === 'red' ? '🔴' : '⚫';
  const rolledName = rolledColor === 'zer' ? 'Зеро' : rolledColor === 'red' ? 'Красное' : 'Чёрное';

  const stepDelay = transport.source === 'telegram' ? 850 : 600;

  await transport.editMessage(
    chat.chatId,
    messageId,
    `🎡 Рулетка крутится...\n👤 ${displayName(player)} | Ставка: ${stake} 🪙 на ${choiceLabel}\n\n💫 Шарик пошёл по ободу: 🔴 14 ▸ ⚫ 29 ▸ 🟢 0 ▸ 🔴 7...`,
    undefined,
    { isAnimation: true }
  );
  await sleep(stepDelay);

  await transport.editMessage(
    chat.chatId,
    messageId,
    `🎡 Рулетка замедляется...\n👤 ${displayName(player)} | Ставка: ${stake} 🪙 на ${choiceLabel}\n\n⏳ Прыгает по лункам: ⚫ 11 ▸ 🔴 23 ▸ ⚫ 8 ▸ ...`,
    undefined,
    { isAnimation: true }
  );
  await sleep(stepDelay);

  const won = rolledColor === choice;
  let payout = 0;
  let wasLoss = false;
  let comment = '';

  if (won) {
    const mult = choice === 'zer' ? 14 : 2;
    payout = stake * mult;
    player.balance += payout;
    player.stats.totalWon += payout - stake;
    if (isLastDodep && player.lastActionWasLoss) {
      player.stats.lastDodepWins += 1;
    }
    player.lastActionWasLoss = false;
    player.lastActionWasLastDodep = false;
    comment = choice === 'zer' ? nextPhrase(chat, 'rouletteZeroWin') : nextPhrase(chat, 'rouletteWin');
  } else {
    player.stats.totalLost += stake;
    player.lastActionWasLoss = true;
    player.lastActionWasLastDodep = false;
    wasLoss = true;
    comment = nextPhrase(chat, 'rouletteLoss');
  }

  if (won && choice === 'zer') {
    unlockAchievement(chat, player, 'zero_sniper');
  }
  player.lastBetAmount = stake;
  player.lastGameType = 'roulette';
  recordGameOutcome(chat, player, 'roulette', won ? payout - stake : -stake, { isLastDodep });
  scheduleSave();

  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: `Рулетка: ${rolledEmoji} ${rolledNum}`,
    detail: won ? `Победа +${payout} (ставка ${stake} на ${choiceLabel})` : `Проигрыш ${stake} на ${choiceLabel}`
  });

  const finalMsg = [
    `🎡 РЕЗУЛЬТАТ РУЛЕТКИ`,
    `👤 Игрок: ${displayName(player)}`,
    `🎯 Ставка: ${stake} 🪙 на ${choiceLabel}`,
    `🎱 Выпало: ${rolledEmoji} ${rolledNum} (${rolledName})`,
    ``,
    won ? `🏆 ЗАНОС! Выигрыш: +${payout} фантиков!` : `🥀 МИМО! Сгорело ${stake} фантиков.`,
    `🪙 Баланс: ${player.balance} фантиков`,
    ``,
    comment
  ].join('\n');

  await transport.editMessage(chat.chatId, messageId, finalMsg, buildPostGameKeyboard('roulette', stake, wasLoss, player));
  if (won && payout > stake) {
    await applyAutoDebtCollection(transport, chat, player, payout - stake);
  }
}

async function renderRussianRouletteState(
  transport: BotTransport,
  chat: ChatState,
  lobby: RussianLobby,
  existingMsgId: string | null
): Promise<void> {
  const pot = lobby.stake * lobby.players.length;
  if (lobby.status === 'waiting') {
    const names = lobby.players.map((p, idx) => `${idx + 1}. ${p.firstName}`).join('\n');
    const text = [
      `🔫 РУССКАЯ РУЛЕТКА (ЛОББИ)`,
      `🪙 Ставка входа: ${lobby.stake} фантиков | 💰 Банк: ${pot} 🪙`,
      `👥 Участники (${lobby.players.length}/3):`,
      names,
      ``,
      lobby.players.length < 2
        ? `Ждём ещё 1–2 смельчаков из чата!`
        : `Можно начинать вдвоём или подождать третьего!`
    ].join('\n');

    const kb: InlineKeyboard = [
      [{ text: `🤝 Вписаться (${lobby.stake} 🪙)`, callbackData: `rr:join:${lobby.id}` }]
    ];
    if (lobby.players.length >= 2) {
      kb.push([{ text: '▶️ Начать этим составом', callbackData: `rr:go:${lobby.id}` }]);
    }
    kb.push([{ text: '❌ Отменить лобби', callbackData: `rr:stop:${lobby.id}` }]);

    if (existingMsgId) {
      await transport.editMessage(chat.chatId, existingMsgId, text, kb);
    } else {
      lobby.messageId = await transport.sendMessage(chat.chatId, text, kb);
    }
    return;
  }

  // Playing state
  const current = lobby.players[lobby.turnIndex];
  const slotsLeft = 6 - lobby.chamber;
  const text = [
    `🔫 РУССКАЯ РУЛЕТКА — БАРАБАН КРУТИТСЯ`,
    `💰 Банк на кону: ${pot} фантиков`,
    `👥 В круге: ${lobby.players.map((p) => p.firstName).join(', ')}`,
    `🎯 Слотов до выстрела: ${slotsLeft} из 6 (в барабане 1 патрон)`,
    ``,
    ...(lobby.historyLines.length > 0 ? [...lobby.historyLines, ''] : []),
    `👉 К виску приставляет ствол: ${current.firstName}`
  ].join('\n');

  const kb: InlineKeyboard = [[{ text: `🔫 Нажать на курок (${current.firstName})`, callbackData: `rr:shot:${lobby.id}` }]];

  if (existingMsgId) {
    await transport.editMessage(chat.chatId, existingMsgId, text, kb);
  } else {
    lobby.messageId = await transport.sendMessage(chat.chatId, text, kb);
  }
}

export function calcMinesMultiplier(bombs: number, safeOpened: number): number {
  if (safeOpened <= 0) return 1.0;
  let prob = 1;
  for (let i = 0; i < safeOpened; i++) {
    prob *= (25 - bombs - i) / (25 - i);
  }
  const mult = 0.97 / prob;
  return Math.round(mult * 100) / 100;
}

async function renderMinesBoard(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  session: MinesSession,
  messageId: string,
  subtitle: string
): Promise<void> {
  const mult = calcMinesMultiplier(session.bombsCount, session.opened.size);
  const potentialWin = Math.round(session.stake * mult);

  const kb: InlineKeyboard = [];
  for (let r = 0; r < 5; r++) {
    const row: InlineButton[] = [];
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c;
      if (session.opened.has(idx)) {
        row.push({ text: '💎', callbackData: `mn:dig:${session.id}:${idx}` });
      } else {
        row.push({ text: '⬜', callbackData: `mn:dig:${session.id}:${idx}` });
      }
    }
    kb.push(row);
  }

  if (session.opened.size > 0) {
    kb.push([{ text: `💰 Забрать ${potentialWin} 🪙 (x${mult.toFixed(2)})`, callbackData: `mn:cash:${session.id}` }]);
  } else {
    kb.push([{ text: '🏳️ Выйти (вернуть ставку)', callbackData: `mn:stop:${session.id}` }]);
  }

  const text = [
    `💣 МИНЫ / САПЁР (5×5)`,
    `👤 Сапёр: ${session.userName} | Ставка: ${session.stake} 🪙 | 💣 Мин: ${session.bombsCount}`,
    `💎 Открыто: ${session.opened.size} | 📈 Множитель: x${mult.toFixed(2)} (${potentialWin} 🪙)`,
    ``,
    subtitle
  ].join('\n');

  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, text, kb);
  } else {
    session.messageId = await transport.sendMessage(chat.chatId, text, kb);
  }
}

async function cashoutMines(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  session: MinesSession,
  callbackId: string,
  messageId: string
): Promise<void> {
  session.status = 'cashed';
  minesSessions.delete(session.id);

  const mult = calcMinesMultiplier(session.bombsCount, session.opened.size);
  const payout = Math.round(session.stake * mult);
  const net = payout - session.stake;

  player.balance += payout;
  player.lastBetAmount = session.stake;
  player.lastGameType = 'mines';
  player.stats.totalWon += Math.max(0, net);
  if (session.isLastDodep && player.lastActionWasLoss) {
    player.stats.lastDodepWins += 1;
  }
  player.lastActionWasLoss = false;
  player.lastActionWasLastDodep = false;
  recordGameOutcome(chat, player, 'mines', Math.max(0, net), { isLastDodep: session.isLastDodep });
  scheduleSave();

  await transport.answerCallback(callbackId, `Забрал ${payout} фантиков (x${mult.toFixed(2)})!`);
  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: session.userName,
    event: `Мины (${session.bombsCount}): Кэшаут x${mult.toFixed(2)}`,
    detail: `Открыто ${session.opened.size} клеток → +${payout} фантиков`
  });

  await renderMinesFinished(transport, chat, player, session, messageId, -1, true);
  if (net > 0) {
    await applyAutoDebtCollection(transport, chat, player, net);
  }
}

async function renderMinesFinished(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  session: MinesSession,
  messageId: string,
  hitCell: number,
  won: boolean
): Promise<void> {
  const mult = calcMinesMultiplier(session.bombsCount, session.opened.size);
  const payout = won ? Math.round(session.stake * mult) : 0;

  let gridVisual = '';
  for (let r = 0; r < 5; r++) {
    let line = '';
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c;
      if (idx === hitCell) line += '💥';
      else if (session.mines.has(idx)) line += '💣';
      else if (session.opened.has(idx)) line += '💎';
      else line += '▫️';
    }
    gridVisual += line + '\n';
  }

  const text = [
    won ? `💣 МИНЫ — УСПЕШНЫЙ КЭШАУТ!` : `💥 МИНЫ — ВЗРЫВ НА ПОЛЕ!`,
    `👤 Сапёр: ${session.userName} | Ставка: ${session.stake} 🪙 | Мин: ${session.bombsCount}`,
    ``,
    gridVisual.trim(),
    ``,
    won
      ? `🏆 Забрал ${payout} фантиков (x${mult.toFixed(2)})!`
      : `🥀 Ставка ${session.stake} фантиков сгорела!`,
    `🪙 Баланс: ${player.balance} фантиков`,
    ``,
    won ? nextPhrase(chat, 'minesCashout') : nextPhrase(chat, 'minesBoom')
  ].join('\n');

  await transport.editMessage(chat.chatId, messageId, text, buildPostGameKeyboard('mines', session.stake, !won, player));
}

/**
 * Generates and sends ONE chat-wide 12:00 daily guidance / quote of the day.
 */
export async function sendDailyHoroscopeBroadcast(
  transport: BotTransport,
  chatId: string,
  forceDate?: string
): Promise<boolean> {
  const chat = getDb().chats[chatId];
  if (!chat) return false;
  const players = Object.values(chat.players);
  if (players.length === 0) return false;

  const dateStr = forceDate || getZonedDateTimeParts().dateStr;
  const guidance = nextPhrase(chat, 'dailyGuidance');
  chat.lastHoroscopeDate = dateStr;
  scheduleSave();

  addBotLog({
    source: 'scheduler',
    chatId: chat.chatId,
    chatTitle: chat.title,
    event: 'Рассылка 12:00 (Напутствие дня)',
    detail: `Отправлена цитата дня на весь чат`
  });

  const text = [
    `🐺 НАПУТСТВИЕ ДНЯ ОТ ДЯДИ ДЕПА (${dateStr})`,
    `📍 Чат: «${chat.title}»`,
    ``,
    guidance
  ].join('\n');

  await transport.sendMessage(chat.chatId, text, [
    [{ text: '🎰 Открыть стол', callbackData: 'menu' }]
  ]);
  return true;
}

/**
 * Generates and sends the 12:01 Hall of Fame & Shame broadcast for a chat.
 */
export async function sendDailyLeaderboardBroadcast(
  transport: BotTransport,
  chatId: string,
  forceDate?: string
): Promise<boolean> {
  const chat = getDb().chats[chatId];
  if (!chat) return false;
  const players = Object.values(chat.players);
  if (players.length === 0) return false;

  const dateStr = forceDate || getZonedDateTimeParts().dateStr;
  chat.lastLeaderboardDate = dateStr;
  scheduleSave();

  addBotLog({
    source: 'scheduler',
    chatId: chat.chatId,
    chatTitle: chat.title,
    event: 'Рассылка 12:01 (Доска почёта)',
    detail: `Опубликован рейтинг для ${players.length} игроков`
  });

  await transport.sendMessage(chat.chatId, buildLeaderboardText(chat), [
    [{ text: '🎰 Ворваться в рейтинг', callbackData: 'menu' }]
  ]);
  return true;
}

// Helper for simulator: allows adding a mock friend action in Russian Roulette
export function getActiveRussianLobbiesForChat(chatId: string) {
  const list: { id: string; stake: number; players: string[]; status: string }[] = [];
  for (const lobby of russianLobbies.values()) {
    if (lobby.chatId === chatId && lobby.status !== 'finished') {
      list.push({
        id: lobby.id,
        stake: lobby.stake,
        players: lobby.players.map((p) => p.firstName),
        status: lobby.status
      });
    }
  }
  return list;
}

// =======================
// PLINKO GAME
// =======================

const PLINKO_MULTIPLIERS: Record<'low' | 'med' | 'high', number[]> = {
  low: [2.4, 1.4, 1.1, 0.4, 1.1, 1.4, 2.4],
  med: [4.5, 1.8, 0.9, 0.25, 0.9, 1.8, 4.5],
  high: [12.0, 1.8, 0.5, 0.1, 0.5, 1.8, 12.0]
};

const PLINKO_RISK_LABELS: Record<'low' | 'med' | 'high', string> = {
  low: '🟢 Низкий риск',
  med: '🟡 Средний риск',
  high: '🔴 Высокий риск'
};

function getPlinkoSlotIcon(mult: number): string {
  if (mult >= 4.0) return '💎';
  if (mult >= 2.0) return '🔥';
  if (mult >= 1.0) return '🟩';
  if (mult >= 0.5) return '🟧';
  return '💀';
}

function plinkoIndent(stepsFromBottom: number): string {
  const emSpaces = '\u2003'.repeat(stepsFromBottom);
  const fineAdjust = ' '.repeat(Math.floor(stepsFromBottom / 2));
  return `${emSpaces}${fineAdjust}`;
}

function renderPlinkoBoardVisual(
  mults: number[],
  pathCols: number[],
  activeRow: number,
  finalSlot?: number
): string {
  const lines: string[] = [];

  // Top drop funnel centered above apex peg (row 0 = 6 steps above pockets)
  const apexIndent = plinkoIndent(6);
  lines.push(`${apexIndent}${activeRow === 0 ? '🟡' : '⬇️'}`);

  // 6 peg rows: row 0 has 1 peg, row 5 has 6 pegs
  for (let r = 0; r < 6; r++) {
    const indent = plinkoIndent(6 - r);
    const pegs: string[] = [];
    for (let c = 0; c <= r; c++) {
      if (finalSlot === undefined && r === activeRow && pathCols[r] === c) {
        pegs.push('🟡');
      } else if (
        (finalSlot !== undefined || r < activeRow) &&
        pathCols[r] === c
      ) {
        pegs.push('🔸');
      } else {
        pegs.push('🔘');
      }
    }
    lines.push(`${indent}${pegs.join('\u2003')}`);
  }

  // 7 pocket buckets directly beneath the 6 bottom pegs
  const pockets = mults.map((m, idx) =>
    idx === finalSlot ? '🟡' : getPlinkoSlotIcon(m)
  );
  lines.push(pockets.join('\u2003'));

  // Multiplier strip
  const multStrip = mults
    .map((m, idx) => (idx === finalSlot ? `【 x${m} 】` : `x${m}`))
    .join(' · ');
  lines.push(``);
  lines.push(
    finalSlot !== undefined
      ? `🎯 Луза №${finalSlot + 1}: ${multStrip}`
      : `🎯 ${multStrip}`
  );

  return lines.join('\n');
}

function buildPlinkoPostKeyboard(
  risk: 'low' | 'med' | 'high',
  stake: number,
  wasLoss: boolean,
  player?: PlayerState
): InlineKeyboard {
  if (player && player.balance <= 0) {
    const elapsed = Date.now() - player.lastZeroBonusAt;
    const bonusReady = player.lastZeroBonusAt === 0 || elapsed >= ZERO_BONUS_COOLDOWN_MS;
    return [
      bonusReady
        ? [{ text: `🤲 Бонус при нуле (+${ZERO_BONUS_AMOUNT} 🪙)`, callbackData: 'bonus_take' }]
        : [
            { text: '🙏 Попросить в долг', callbackData: 'ln:ask' },
            { text: `⏳ Бонус (+${ZERO_BONUS_AMOUNT})`, callbackData: 'bonus' }
          ],
      [
        { text: '🧳 Шкатулка / Кейсы', callbackData: 'tl:menu' },
        { text: '🏠 В меню', callbackData: 'menu' }
      ]
    ];
  }

  const riskShort = risk === 'low' ? '🟢' : risk === 'high' ? '🔴' : '🟡';
  const rows: InlineKeyboard = [
    [
      {
        text: `🔺 Ещё бросок ${riskShort} (${stake} 🪙)`,
        callbackData: `pl:go:${risk}:${stake}:0`
      }
    ]
  ];
  if (wasLoss) {
    rows[0].push({
      text: `🔥 Ласт додеп (${stake * 2} 🪙)`,
      callbackData: `pl:go:${risk}:${stake * 2}:1`
    });
  }
  rows.push([
    { text: '🎛 Сменить риск', callbackData: `b:plinko:${stake}` },
    { text: '↩️ Меню', callbackData: 'menu' }
  ]);
  return rows;
}

async function playPlinkoDrop(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  messageId: string,
  stake: number,
  risk: 'low' | 'med' | 'high',
  isLastDodep: boolean
): Promise<void> {
  deductPlayerStake(player, stake);
  scheduleSave();

  const mults = PLINKO_MULTIPLIERS[risk] || PLINKO_MULTIPLIERS.med;
  const riskLabel = PLINKO_RISK_LABELS[risk] || PLINKO_RISK_LABELS.med;

  // Row 0 starts on single apex peg (col 0), 6 binary bounces yield slot 0..6
  let slot = 0;
  const pathCols: number[] = [0];
  for (let r = 0; r < 6; r++) {
    if (Math.random() >= 0.5) slot += 1;
    if (r < 5) pathCols.push(slot);
  }

  const stepDelay = transport.source === 'telegram' ? 520 : 350;

  // Frame 1: Ball enters row 1
  const dir1 = pathCols[1] > pathCols[0] ? '↘️ Вправо' : '↙️ Влево';
  await transport.editMessage(
    chat.chatId,
    messageId,
    [
      `🔺 ПЛИНКО · ${riskLabel}`,
      `👤 ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
      `💫 Шарик пошёл (${dir1})`,
      ``,
      renderPlinkoBoardVisual(mults, pathCols, 1)
    ].join('\n'),
    undefined,
    { isAnimation: true }
  );
  await sleep(stepDelay);

  // Frame 2: Ball midway at row 3
  const dir3 = pathCols[3] > pathCols[2] ? '↘️ Вправо' : '↙️ Влево';
  await transport.editMessage(
    chat.chatId,
    messageId,
    [
      `🔺 ПЛИНКО · ${riskLabel}`,
      `👤 ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
      `⚡ Середина пирамиды (${dir3})`,
      ``,
      renderPlinkoBoardVisual(mults, pathCols, 3)
    ].join('\n'),
    undefined,
    { isAnimation: true }
  );
  await sleep(stepDelay);

  // Frame 3: Ball at final peg row 5
  const dir5 = pathCols[5] > pathCols[4] ? '↘️ К правому краю' : '↙️ К левому краю';
  await transport.editMessage(
    chat.chatId,
    messageId,
    [
      `🔺 ПЛИНКО · ${riskLabel}`,
      `👤 ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
      `🔥 Последний штырёк (${dir5})`,
      ``,
      renderPlinkoBoardVisual(mults, pathCols, 5)
    ].join('\n'),
    undefined,
    { isAnimation: true }
  );
  await sleep(stepDelay);

  const mult = mults[slot];
  const payout = Math.round(stake * mult);
  const netProfit = payout - stake;
  const wasLoss = payout < stake;

  player.balance += payout;
  player.lastBetAmount = stake;
  player.lastGameType = 'plinko';

  if (payout > stake) {
    player.stats.totalWon += netProfit;
    if (isLastDodep && player.lastActionWasLoss) {
      player.stats.lastDodepWins += 1;
    }
    player.lastActionWasLoss = false;
  } else if (payout < stake) {
    player.stats.totalLost += stake - payout;
    player.lastActionWasLoss = true;
  } else {
    player.lastActionWasLoss = false;
  }
  player.lastActionWasLastDodep = false;
  recordGameOutcome(chat, player, 'plinko', netProfit, { isLastDodep });
  scheduleSave();

  const comment =
    mult >= 2.5
      ? nextPhrase(chat, 'plinkoBigWin')
      : mult >= 1.0
        ? nextPhrase(chat, 'plinkoWin')
        : nextPhrase(chat, 'plinkoLoss');

  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: `Плинко (${risk}): x${mult}`,
    detail: `Ставка ${stake} → Выплата ${payout} 🪙`
  });

  const outcomeLine =
    payout > stake
      ? `🏆 ЗАНОС x${mult}! Выплата: +${payout} 🪙 (чистыми +${netProfit})`
      : payout === stake
        ? `🤝 ПРИ СВОИХ x${mult}! Возврат ${payout} 🪙.`
        : `🥀 МИМО x${mult} · Вернулось ${payout} из ${stake} 🪙.`;

  const finalMsg = [
    `🔺 ПЛИНКО · ИТОГ (${riskLabel})`,
    `👤 ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
    ``,
    renderPlinkoBoardVisual(mults, pathCols, 6, slot),
    ``,
    outcomeLine,
    `🪙 Баланс: ${player.balance} фантиков`,
    ``,
    comment
  ].join('\n');

  await transport.editMessage(
    chat.chatId,
    messageId,
    finalMsg,
    buildPlinkoPostKeyboard(risk, stake, wasLoss, player)
  );

  if (netProfit > 0) {
    await applyAutoDebtCollection(transport, chat, player, netProfit);
  }
}

// =======================
// P2P LOANS & COLLECTOR ("ПАЦАНСКИЙ ОБЩАК")
// =======================

async function handleLoanCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  if (!chat.loans) chat.loans = [];
  if (!chat.loanRequests) chat.loanRequests = [];

  const sub = parts[1] || 'menu';
  const now = Date.now();

  if (sub === 'menu') {
    await transport.answerCallback(callbackId);
    const myDebts = getActiveLoansForBorrower(chat, player.userId);
    const myCredits = getActiveLoansForLender(chat, player.userId);
    const openRequests = chat.loanRequests.filter((r) => r.status === 'open');

    const lines: string[] = [
      `🤝 ПАЦАНСКИЙ ОБЩАК — P2P ДОЛГИ И ЗАЙМЫ`,
      `👤 Профиль: ${playerLabel(chat, player)} | 🪙 Баланс: ${player.balance} 🪙 | 🎲 Игр: ${player.stats.gamesPlayed}`,
      `ℹ️ Займы только между игроками чата (срок 2 ч, автосбор с побед: 50% в срок / до 100% при просрочке).`,
      ``
    ];

    const kb: InlineKeyboard = [];

    if (myDebts.length === 0) {
      lines.push(`📉 Твои долги: чисто, никому не должен.`);
    } else {
      lines.push(`📉 Твои активные долги:`);
      for (const l of myDebts) {
        const rem = getRemainingDebt(l);
        const overdue = isLoanOverdue(l, now);
        const timeInfo = overdue
          ? `ПРОСРОЧЕН на ${formatDuration(now - l.dueAt)} 🔥`
          : `осталось ${formatDuration(l.dueAt - now)}`;
        lines.push(`• ${l.lenderName}: осталось ${rem} из ${l.repayAmount} 🪙 (${timeInfo})`);
        if (player.balance > 0) {
          const payAmt = Math.min(rem, player.balance);
          kb.push([{ text: `💸 Отдать ${l.lenderName} (${payAmt} 🪙)`, callbackData: `ln:pay:${l.id}` }]);
        }
      }
    }

    lines.push(``);
    if (myCredits.length === 0) {
      lines.push(`📈 Тебе должны: никто пока не брал.`);
    } else {
      lines.push(`📈 Твои выданные займы:`);
      for (const l of myCredits) {
        const rem = getRemainingDebt(l);
        const overdue = isLoanOverdue(l, now);
        const tag = overdue ? ' [ПРОСРОЧЕН 🔥]' : '';
        lines.push(`• ${l.borrowerName}: должен ${rem} из ${l.repayAmount} 🪙${tag}`);
        kb.push([
          { text: `👊 Напомнить (${l.borrowerName})`, callbackData: `ln:rem:${l.id}` },
          { text: `🕊 Простить`, callbackData: `ln:frg:${l.id}` }
        ]);
      }
    }

    if (openRequests.length > 0) {
      lines.push(``);
      lines.push(`📣 Открытые заявки в чате:`);
      for (const r of openRequests.slice(-5)) {
        lines.push(`• ${r.borrowerName} просит ${r.principal} 🪙 (вернёт ${r.repayAmount} 🪙, +${r.interestPct}%)`);
        if (r.borrowerId === player.userId) {
          kb.push([{ text: `❌ Отменить свою заявку (${r.principal} 🪙)`, callbackData: `ln:cancel:${r.id}` }]);
        } else {
          kb.push([{ text: `💸 Выручить ${r.borrowerName} (${r.principal} 🪙)`, callbackData: `ln:fund:${r.id}` }]);
        }
      }
    }

    kb.push([{ text: '🙏 Попросить в долг в чате', callbackData: 'ln:ask' }]);
    kb.push([{ text: '🏠 В меню', callbackData: 'menu' }]);

    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, lines.join('\n'), kb);
    } else {
      await transport.sendMessage(chat.chatId, lines.join('\n'), kb);
    }
    return;
  }

  if (sub === 'ask') {
    const checkError = validateBorrowerEligibility(chat, player, 0);
    if (checkError) {
      await transport.answerCallback(callbackId, checkError, true);
      return;
    }

    const existingOpen = chat.loanRequests.find((r) => r.borrowerId === player.userId && r.status === 'open');
    if (existingOpen) {
      await transport.answerCallback(callbackId);
      const existingText = [
        `🙏 У ТЕБЯ УЖЕ ЕСТЬ ОТКРЫТАЯ ЗАЯВКА`,
        `🪙 Сумма: ${existingOpen.principal} 🪙 → к возврату ${existingOpen.repayAmount} 🪙 (+${existingOpen.interestPct}%)`,
        ``,
        `Чтобы создать новую заявку, сначала отмени старую (кнопка ниже) или дождись, пока кто-то из чата тебя выручит.`
      ].join('\n');
      const existingKb: InlineKeyboard = [
        [{ text: `❌ Отменить заявку (${existingOpen.principal} 🪙)`, callbackData: `ln:cancel:${existingOpen.id}` }],
        [{ text: '↩️ К долгам', callbackData: 'ln:menu' }]
      ];
      if (messageId) {
        await transport.editMessage(chat.chatId, messageId, existingText, existingKb);
      } else {
        await transport.sendMessage(chat.chatId, existingText, existingKb);
      }
      return;
    }

    await transport.answerCallback(callbackId);
    const totalDebt = getTotalRemainingDebt(chat, player.userId);
    const maxAllowed = MAX_TOTAL_DEBT_PER_BORROWER - totalDebt;

    const askText = [
      `🙏 ЗАПРОС В ДОЛГ — ШАГ 1/2`,
      `👤 Просит: ${playerLabel(chat, player)} | 🪙 Баланс: ${player.balance} 🪙`,
      `📊 Текущий долг: ${totalDebt} / ${MAX_TOTAL_DEBT_PER_BORROWER} 🪙 (доступно ещё: ${maxAllowed} 🪙)`,
      ``,
      `Сколько фантиков попросить у пацанов в чате?`
    ].join('\n');
    const askKb: InlineKeyboard = [
      [
        { text: '100 🪙', callbackData: 'ln:amt:100' },
        { text: '250 🪙', callbackData: 'ln:amt:250' },
        { text: '500 🪙', callbackData: 'ln:amt:500' },
        { text: '1000 🪙', callbackData: 'ln:amt:1000' }
      ],
      [{ text: '↩️ К долгам', callbackData: 'ln:menu' }]
    ];

    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, askText, askKb);
    } else {
      await transport.sendMessage(chat.chatId, askText, askKb);
    }
    return;
  }

  if (sub === 'amt') {
    const amount = parseInt(parts[2], 10);
    if (![100, 250, 500, 1000].includes(amount)) {
      await transport.answerCallback(callbackId, 'Некорректная сумма займа.', true);
      return;
    }
    const checkError = validateBorrowerEligibility(chat, player, amount);
    if (checkError) {
      await transport.answerCallback(callbackId, checkError, true);
      return;
    }

    await transport.answerCallback(callbackId);
    await transport.editMessage(
      chat.chatId,
      messageId,
      [
        `🙏 ЗАПРОС В ДОЛГ — ШАГ 2/2`,
        `👤 Просит: ${playerLabel(chat, player)} | Сумма: ${amount} 🪙`,
        `⏳ Срок возврата: 2 часа (дальше включится статус [ДОЛЖНИК]).`,
        ``,
        `На каких условиях готов вернуть?`
      ].join('\n'),
      [
        [{ text: `🤝 По-братски (0% → вернуть ${amount} 🪙)`, callbackData: `ln:req:${amount}:0` }],
        [{ text: `🍺 Под пивко (+20% → вернуть ${Math.round(amount * 1.2)} 🪙)`, callbackData: `ln:req:${amount}:20` }],
        [{ text: `🦈 По-жёсткому (+50% → вернуть ${Math.round(amount * 1.5)} 🪙)`, callbackData: `ln:req:${amount}:50` }],
        [{ text: '↩️ Назад', callbackData: 'ln:ask' }]
      ]
    );
    return;
  }

  if (sub === 'req') {
    const amount = parseInt(parts[2], 10);
    const pct = parseInt(parts[3], 10);
    if (![100, 250, 500, 1000].includes(amount) || ![0, 20, 50].includes(pct)) {
      await transport.answerCallback(callbackId, 'Некорректные параметры заявки.', true);
      return;
    }

    const checkError = validateBorrowerEligibility(chat, player, amount);
    if (checkError) {
      await transport.answerCallback(callbackId, checkError, true);
      return;
    }

    const existingOpen = chat.loanRequests.find((r) => r.borrowerId === player.userId && r.status === 'open');
    if (existingOpen) {
      await transport.answerCallback(callbackId, 'У тебя уже висит открытая заявка в чате!', true);
      return;
    }

    const repayAmount = Math.round(amount * (1 + pct / 100));
    const req: LoanRequest = {
      id: shortId(),
      chatId: chat.chatId,
      borrowerId: player.userId,
      borrowerName: displayName(player),
      principal: amount,
      repayAmount,
      interestPct: pct,
      createdAt: now,
      status: 'open',
      messageId: null
    };
    chat.loanRequests.push(req);
    if (chat.loanRequests.length > 50) {
      chat.loanRequests = chat.loanRequests.slice(-50);
    }
    scheduleSave();

    await transport.answerCallback(callbackId, 'Заявка отправлена в чат!');
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'Заявка на P2P займ',
      detail: `Просит ${amount} 🪙 (к возврату ${repayAmount} 🪙, +${pct}%)`
    });

    const pctLabel = pct === 0 ? 'без процентов, по-братски' : `+${pct}%`;
    const cardText = [
      `🙏 КТО ВЫРУЧИТ КЕНТА В ДОЛГ?`,
      `👤 Просит: ${playerLabel(chat, player)} (игр: ${player.stats.gamesPlayed})`,
      `🪙 Нужно: ${amount} фантиков`,
      `📝 Возврат за 2 ч: ${repayAmount} фантиков (${pctLabel})`,
      `💼 Гарантия: Дядя Деп забирает 50% с каждого чистого заноса (и до 100% при просрочке).`,
      ``,
      `Пацаны, кто скинет со своего баланса? 👇`
    ].join('\n');

    const sentId = await transport.sendMessage(chat.chatId, cardText, [
      [{ text: `💸 Выручить (${amount} 🪙)`, callbackData: `ln:fund:${req.id}` }],
      [{ text: '❌ Отменить заявку', callbackData: `ln:cancel:${req.id}` }]
    ]);
    req.messageId = sentId;
    scheduleSave();
    return;
  }

  if (sub === 'cancel') {
    const reqId = parts[2];
    const req = chat.loanRequests.find((r) => r.id === reqId);
    if (!req || req.status !== 'open') {
      await transport.answerCallback(callbackId, 'Эта заявка уже неактивна.', true);
      return;
    }
    if (req.borrowerId !== player.userId) {
      await transport.answerCallback(callbackId, 'Отменить заявку может только сам проситель!', true);
      return;
    }
    req.status = 'cancelled';
    scheduleSave();
    await transport.answerCallback(callbackId, 'Заявка отменена.');
    await transport.editMessage(
      chat.chatId,
      req.messageId || messageId,
      `❌ Заявка на займ (${req.principal} 🪙 от ${req.borrowerName}) отменена просителем.`,
      [[{ text: '🏠 В меню', callbackData: 'menu' }]]
    );
    return;
  }

  if (sub === 'fund') {
    const reqId = parts[2];
    const req = chat.loanRequests.find((r) => r.id === reqId);
    if (!req || req.status !== 'open') {
      await transport.answerCallback(callbackId, 'Заявку уже закрыли или кто-то опередил!', true);
      return;
    }
    if (req.borrowerId === player.userId) {
      await transport.answerCallback(callbackId, 'Самому себе занять нельзя, брат!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `Ты Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    if (player.stats.gamesPlayed < MIN_GAMES_FOR_LOANS) {
      await transport.answerCallback(
        callbackId,
        `Сначала сыграй минимум ${MIN_GAMES_FOR_LOANS} игры в чате, чтобы выдавать займы!`,
        true
      );
      return;
    }
    if (player.balance < req.principal) {
      await transport.answerCallback(
        callbackId,
        `Не хватает фантиков! Нужно ${req.principal}, а у тебя ${player.balance}.`,
        true
      );
      return;
    }

    const borrower = chat.players[req.borrowerId];
    if (!borrower) {
      await transport.answerCallback(callbackId, 'Проситель не найден в чате.', true);
      return;
    }
    const borrowerCheck = validateBorrowerEligibility(chat, borrower, req.principal);
    if (borrowerCheck) {
      req.status = 'cancelled';
      scheduleSave();
      await transport.answerCallback(callbackId, `Заявка аннулирована: ${borrowerCheck}`, true);
      return;
    }

    // Execute P2P transfer
    player.balance -= req.principal;
    player.lastLoanGivenAt = now;
    borrower.balance += req.principal;
    req.status = 'filled';

    const loan: LoanRecord = {
      id: shortId(),
      chatId: chat.chatId,
      lenderId: player.userId,
      lenderName: displayName(player),
      borrowerId: borrower.userId,
      borrowerName: displayName(borrower),
      principal: req.principal,
      repayAmount: req.repayAmount,
      interestPct: req.interestPct,
      paidAmount: 0,
      createdAt: now,
      dueAt: now + LOAN_DURATION_MS,
      lastRemindedAt: 0,
      status: 'active'
    };
    chat.loans.push(loan);
    unlockAchievement(chat, player, 'philanthropist');
    scheduleSave();

    await transport.answerCallback(callbackId, `Выручил ${displayName(borrower)} на ${req.principal} 🪙!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'P2P Займ выдан',
      detail: `${displayName(player)} → ${displayName(borrower)}: ${req.principal} 🪙 (к возврату ${req.repayAmount} 🪙)`
    });

    await transport.editMessage(
      chat.chatId,
      req.messageId || messageId,
      [
        `🤝 СДЕЛКА ЗАКРЫТА!`,
        `💸 ${displayName(player)} выручил ${displayName(borrower)} на ${req.principal} фантиков!`,
        `📝 К возврату за 2 ч: ${req.repayAmount} 🪙`,
        ``,
        nextPhrase(chat, 'loanGranted')
      ].join('\n'),
      [
        [
          { text: `💸 Погасить долг`, callbackData: `ln:pay:${loan.id}` },
          { text: '🏠 В меню', callbackData: 'menu' }
        ]
      ]
    );
    return;
  }

  if (sub === 'pay') {
    const loanId = parts[2];
    const loan = chat.loans.find((l) => l.id === loanId);
    if (!loan || loan.status !== 'active') {
      await transport.answerCallback(callbackId, 'Этот долг уже закрыт.', true);
      return;
    }
    if (loan.borrowerId !== player.userId) {
      await transport.answerCallback(callbackId, 'Чужие долги не гасим (если только не по кнопке Выручить)!', true);
      return;
    }
    if (player.balance <= 0) {
      await transport.answerCallback(callbackId, 'На счету 0 фантиков — нечем платить!', true);
      return;
    }

    const remaining = getRemainingDebt(loan);
    const payAmt = Math.min(remaining, player.balance);
    player.balance -= payAmt;
    loan.paidAmount += payAmt;

    const lender = chat.players[loan.lenderId];
    if (lender) lender.balance += payAmt;

    const leftAfter = getRemainingDebt(loan);
    if (leftAfter === 0) {
      loan.status = 'repaid';
    }
    scheduleSave();

    await transport.answerCallback(
      callbackId,
      leftAfter === 0 ? `Долг полностью погашен (-${payAmt} 🪙)!` : `Внесено ${payAmt} 🪙, осталось ${leftAfter} 🪙.`
    );
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: leftAfter === 0 ? 'P2P Долг погашен' : 'P2P Частичный возврат',
      detail: `${displayName(player)} → ${loan.lenderName}: ${payAmt} 🪙 (осталось ${leftAfter})`
    });

    await transport.sendMessage(
      chat.chatId,
      [
        leftAfter === 0 ? `✅ ДОЛГ ПОГАШЕН ПОЛНОСТЬЮ!` : `💸 ЧАСТИЧНЫЙ ВОЗВРАТ ДОЛГА`,
        `👤 ${playerLabel(chat, player)} перевёл ${payAmt} 🪙 кенту ${loan.lenderName}`,
        leftAfter === 0 ? `🤝 Расписка закрыта, совесть чиста!` : `📌 Осталось вернуть: ${leftAfter} 🪙`,
        `🪙 Баланс: ${player.balance} фантиков`,
        ``,
        nextPhrase(chat, 'loanRepaid')
      ].join('\n'),
      [
        [
          { text: '🤝 Долги и займы', callbackData: 'ln:menu' },
          { text: '🏠 В меню', callbackData: 'menu' }
        ]
      ]
    );
    return;
  }

  if (sub === 'rem') {
    const loanId = parts[2];
    const loan = chat.loans.find((l) => l.id === loanId);
    if (!loan || loan.status !== 'active') {
      await transport.answerCallback(callbackId, 'Этот долг уже закрыт.', true);
      return;
    }
    if (loan.lenderId !== player.userId) {
      await transport.answerCallback(callbackId, 'Напоминать может только тот, кто занимал!', true);
      return;
    }
    const elapsed = now - (loan.lastRemindedAt || 0);
    if (loan.lastRemindedAt > 0 && elapsed < LOAN_REMIND_COOLDOWN_MS) {
      const wait = formatDuration(LOAN_REMIND_COOLDOWN_MS - elapsed);
      await transport.answerCallback(callbackId, `Не части! Напомнить снова можно через ${wait}.`, true);
      return;
    }

    loan.lastRemindedAt = now;
    scheduleSave();
    const rem = getRemainingDebt(loan);
    const borrower = chat.players[loan.borrowerId];
    const borrowerTitle = borrower ? playerLabel(chat, borrower) : loan.borrowerName;

    await transport.answerCallback(callbackId, 'Напоминание отправлено в чат!');
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'Напоминание о долге',
      detail: `${displayName(player)} → ${loan.borrowerName}: осталось ${rem} 🪙`
    });

    await transport.sendMessage(
      chat.chatId,
      [
        `👊 НАПОМИНАНИЕ О ДОЛГЕ`,
        `📣 ${borrowerTitle}, кент ${displayName(player)} ждёт возврат ${rem} фантиков!`,
        ``,
        nextPhrase(chat, 'loanReminder')
      ].join('\n'),
      [
        [
          { text: '💸 Погасить долг', callbackData: `ln:pay:${loan.id}` },
          { text: '🏠 В меню', callbackData: 'menu' }
        ]
      ]
    );
    return;
  }

  if (sub === 'frg') {
    const loanId = parts[2];
    const loan = chat.loans.find((l) => l.id === loanId);
    if (!loan || loan.status !== 'active') {
      await transport.answerCallback(callbackId, 'Этот долг уже закрыт.', true);
      return;
    }
    if (loan.lenderId !== player.userId) {
      await transport.answerCallback(callbackId, 'Простить долг может только сам кредитор!', true);
      return;
    }

    const rem = getRemainingDebt(loan);
    loan.status = 'forgiven';
    scheduleSave();

    await transport.answerCallback(callbackId, `Ты простил долг ${loan.borrowerName} (${rem} 🪙)!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'P2P Долг прощён',
      detail: `${displayName(player)} простил ${loan.borrowerName} (${rem} 🪙)`
    });

    await transport.sendMessage(
      chat.chatId,
      [
        `🕊 ШИРОКИЙ ЖЕСТ!`,
        `👑 ${displayName(player)} простил долг (${rem} 🪙) игроку ${loan.borrowerName}!`,
        ``,
        nextPhrase(chat, 'loanForgiven')
      ].join('\n'),
      [[{ text: '🏠 В меню', callbackData: 'menu' }]]
    );
  }
}

function validateBorrowerEligibility(chat: ChatState, player: PlayerState, requestedAmount: number): string | null {
  if (player.stats.gamesPlayed < MIN_GAMES_FOR_LOANS) {
    return `Чтобы просить в долг, нужно сыграть минимум ${MIN_GAMES_FOR_LOANS} игры в чате (у тебя ${player.stats.gamesPlayed}).`;
  }
  const active = getActiveLoansForBorrower(chat, player.userId);
  if (active.length >= MAX_ACTIVE_LOANS_PER_BORROWER) {
    return `У тебя уже ${active.length} активных долга (максимум ${MAX_ACTIVE_LOANS_PER_BORROWER}). Сначала закрой старые!`;
  }
  const totalDebt = getTotalRemainingDebt(chat, player.userId);
  if (totalDebt >= MAX_TOTAL_DEBT_PER_BORROWER) {
    return `Достигнут лимит общего долга (${totalDebt}/${MAX_TOTAL_DEBT_PER_BORROWER} 🪙).`;
  }
  if (requestedAmount > 0 && totalDebt + requestedAmount > MAX_TOTAL_DEBT_PER_BORROWER) {
    return `С учётом текущего долга (${totalDebt} 🪙) нельзя занять ещё ${requestedAmount} 🪙 (общий потолок ${MAX_TOTAL_DEBT_PER_BORROWER} 🪙).`;
  }
  return null;
}

// =======================
// COCKROACH RACES ("ТАРАКАНЬИ БЕГА")
// =======================

const RACE_RUNNERS = [
  { emoji: '🪳', name: 'Виталя' },
  { emoji: '🐌', name: 'Тормоз' },
  { emoji: '🐀', name: 'Крысюк' },
  { emoji: '🦀', name: 'Олигарх' }
];

const RACE_TRACK_LEN = 12;

function renderRaceTracks(positions: number[], winnerLane?: number): string {
  return RACE_RUNNERS.map((runner, idx) => {
    const pos = Math.min(RACE_TRACK_LEN, positions[idx] || 0);
    const left = '➖'.repeat(pos);
    const right = '➖'.repeat(Math.max(0, RACE_TRACK_LEN - pos));
    const winMark = winnerLane === idx ? ' 🏆' : '';
    return `${idx + 1}. ${runner.emoji} ${runner.name}: |${left}${runner.emoji}${right}🏁${winMark}`;
  }).join('\n');
}

function buildRaceLobbyText(chat: ChatState, lobby: RaceLobby): string {
  const pot = lobby.bets.reduce((s, b) => s + b.amount, 0);
  const betLines = lobby.bets.map((b) => {
    const r = RACE_RUNNERS[b.lane];
    return `• ${b.firstName} → ${r.emoji} ${r.name} (${b.amount} 🪙)`;
  });
  return [
    `🪳 ТАРАКАНЬИ БЕГА — ЗАПИСЬ НА ЗАЕЗД`,
    `🪙 Ставка: ${lobby.stake} 🪙 | 💰 Банк: ${pot} 🪙`,
    ``,
    renderRaceTracks(lobby.positions),
    ``,
    `📋 Ставки чата (${lobby.bets.length}):`,
    ...betLines,
    ``,
    `Жми на своего таракана чтобы вписаться (соло-старт платит x3.8, в чате — делят весь банк)!`
  ].join('\n');
}

function buildRaceLobbyKeyboard(lobby: RaceLobby): InlineKeyboard {
  return [
    [
      { text: `🪳 Виталя (${lobby.stake})`, callbackData: `rc:bet:${lobby.id}:0` },
      { text: `🐌 Тормоз (${lobby.stake})`, callbackData: `rc:bet:${lobby.id}:1` }
    ],
    [
      { text: `🐀 Крысюк (${lobby.stake})`, callbackData: `rc:bet:${lobby.id}:2` },
      { text: `🦀 Олигарх (${lobby.stake})`, callbackData: `rc:bet:${lobby.id}:3` }
    ],
    [
      { text: '🏁 Старт забега!', callbackData: `rc:go:${lobby.id}` },
      { text: '❌ Отменить', callbackData: `rc:stop:${lobby.id}` }
    ]
  ];
}

async function handleRaceCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];

  if (sub === 'new') {
    const lane = parseInt(parts[2], 10);
    const stake = parseInt(parts[3], 10);
    const isLastDodep = parts[4] === '1';
    if (Number.isNaN(lane) || lane < 0 || lane > 3 || Number.isNaN(stake) || stake <= 0) {
      await transport.answerCallback(callbackId, 'Некорректные параметры забега.', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `Призрак чата: жди ${formatDuration(ghostMs)}`, true);
      return;
    }
    if (player.balance < stake) {
      await transport.answerCallback(callbackId, 'Недостаточно фантиков!', true);
      return;
    }

    deductPlayerStake(player, stake);
    scheduleSave();

    const sid = shortId();
    const lobby: RaceLobby = {
      id: sid,
      chatId: chat.chatId,
      stake,
      creatorId: player.userId,
      bets: [{ userId: player.userId, firstName: displayName(player), lane, amount: stake, isLastDodep }],
      positions: [0, 0, 0, 0],
      status: 'waiting',
      messageId: messageId || null,
      transportSource: transport.source,
      transport,
      createdAt: Date.now()
    };
    raceLobbies.set(sid, lobby);
    markRuntimeDirty();

    const runner = RACE_RUNNERS[lane];
    await transport.answerCallback(callbackId, `Забег открыт! Твоя ставка на ${runner.emoji} ${runner.name}.`);
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, buildRaceLobbyText(chat, lobby), buildRaceLobbyKeyboard(lobby));
    } else {
      lobby.messageId = await transport.sendMessage(chat.chatId, buildRaceLobbyText(chat, lobby), buildRaceLobbyKeyboard(lobby));
    }
    return;
  }

  const sid = parts[2];
  const lobby = raceLobbies.get(sid);
  if (!lobby) {
    await transport.answerCallback(callbackId, 'Этот забег уже финишировал или отменён.', true);
    return;
  }

  if (sub === 'bet') {
    const lane = parseInt(parts[3], 10);
    if (lobby.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Тараканы уже бегут, ставки закрыты!', true);
      return;
    }
    if (Number.isNaN(lane) || lane < 0 || lane > 3) return;
    if (lobby.bets.some((b) => b.userId === player.userId)) {
      await transport.answerCallback(callbackId, 'Ты уже поставил на этот забег!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `Призрак чата: жди ${formatDuration(ghostMs)}`, true);
      return;
    }
    if (player.balance < lobby.stake) {
      await transport.answerCallback(callbackId, `Нужно ${lobby.stake} фантиков, у тебя ${player.balance}.`, true);
      return;
    }

    deductPlayerStake(player, lobby.stake);
    lobby.bets.push({
      userId: player.userId,
      firstName: displayName(player),
      lane,
      amount: lobby.stake,
      isLastDodep: false
    });
    scheduleSave();

    const runner = RACE_RUNNERS[lane];
    await transport.answerCallback(callbackId, `Принято! Ты поставил ${lobby.stake} 🪙 на ${runner.emoji} ${runner.name}!`);
    await transport.editMessage(chat.chatId, messageId, buildRaceLobbyText(chat, lobby), buildRaceLobbyKeyboard(lobby));
    return;
  }

  if (sub === 'stop') {
    if (lobby.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Поздно отменять — старт уже дан!', true);
      return;
    }
    if (player.userId !== lobby.creatorId) {
      await transport.answerCallback(callbackId, 'Только создатель может отменить забег!', true);
      return;
    }
    for (const b of lobby.bets) {
      const p = chat.players[b.userId];
      if (p) p.balance += b.amount;
    }
    lobby.status = 'finished';
    raceLobbies.delete(sid);
    scheduleSave();
    await transport.answerCallback(callbackId, 'Забег отменён, ставки возвращены.');
    await transport.editMessage(
      chat.chatId,
      messageId,
      `❌ Тараканьи бега отменены. Все ставки (${lobby.stake} 🪙) возвращены участникам.`,
      [[{ text: '🏠 В меню', callbackData: 'menu' }]]
    );
    return;
  }

  if (sub === 'go') {
    if (lobby.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Забег уже идёт!', true);
      return;
    }
    lobby.status = 'running';
    raceLobbies.delete(sid);
    await transport.answerCallback(callbackId, 'Поехали! Болеем за наших!');

    const pot = lobby.bets.reduce((s, b) => s + b.amount, 0);
    const stepDelay = transport.source === 'telegram' ? 1100 : 550;

    for (let tick = 0; tick < 6; tick++) {
      for (let i = 0; i < 4; i++) {
        const roll = Math.random();
        const step = roll < 0.12 ? 0 : roll < 0.45 ? 1 : roll < 0.82 ? 2 : 3;
        lobby.positions[i] = Math.min(RACE_TRACK_LEN, lobby.positions[i] + step);
      }

      const maxPos = Math.max(...lobby.positions);
      const finished = maxPos >= RACE_TRACK_LEN;
      if (finished || tick === 5) break;

      await transport.editMessage(
        chat.chatId,
        messageId,
        [
          `🪳 ТАРАКАНЬИ БЕГА — В ПУТИ!`,
          `💰 Банк: ${pot} 🪙 | Участников: ${lobby.bets.length}`,
          ``,
          renderRaceTracks(lobby.positions),
          ``,
          `🎙 ${nextPhrase(chat, 'raceStepQuotes')}`
        ].join('\n'),
        undefined,
        { isAnimation: true }
      );
      await sleep(stepDelay);
    }

    const topPos = Math.max(...lobby.positions);
    const topLanes = [0, 1, 2, 3].filter((idx) => lobby.positions[idx] === topPos);
    const winnerLane = topLanes[Math.floor(Math.random() * topLanes.length)];
    lobby.positions[winnerLane] = RACE_TRACK_LEN;
    lobby.status = 'finished';

    const winnerRunner = RACE_RUNNERS[winnerLane];
    const winners = lobby.bets.filter((b) => b.lane === winnerLane);
    const isHousePay = lobby.bets.length === 1 || winners.length === lobby.bets.length;

    const payoutLines: string[] = [];
    const autoCollectQueue: { player: PlayerState; net: number }[] = [];
    const zeroOfferQueue: PlayerState[] = [];

    for (const b of lobby.bets) {
      const ps = chat.players[b.userId];
      if (!ps) continue;
      ps.lastBetAmount = b.amount;
      ps.lastGameType = 'races';

      if (b.lane === winnerLane) {
        const payout = isHousePay ? Math.round(b.amount * 3.8) : Math.floor(pot / winners.length);
        const net = payout - b.amount;
        ps.balance += payout;
        ps.stats.totalWon += Math.max(0, net);
        if (b.isLastDodep && ps.lastActionWasLoss) {
          ps.stats.lastDodepWins += 1;
        }
        ps.lastActionWasLoss = false;
        ps.lastActionWasLastDodep = false;
        recordGameOutcome(chat, ps, 'races', net, { isLastDodep: b.isLastDodep });
        payoutLines.push(`🏆 ${playerLabel(chat, ps)} забирает +${payout} 🪙 (баланс: ${ps.balance})`);
        if (net > 0) autoCollectQueue.push({ player: ps, net });
      } else {
        ps.stats.totalLost += b.amount;
        ps.lastActionWasLoss = true;
        ps.lastActionWasLastDodep = false;
        recordGameOutcome(chat, ps, 'races', -b.amount, { isLastDodep: b.isLastDodep });
        payoutLines.push(`🥀 ${playerLabel(chat, ps)} мимо (-${b.amount} 🪙)`);
        if (ps.balance === 0) zeroOfferQueue.push(ps);
      }
    }
    scheduleSave();

    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: winners.length > 0 ? winners.map((w) => w.firstName).join(', ') : 'Дядя Деп',
      event: `Бега: победил ${winnerRunner.emoji} ${winnerRunner.name}`,
      detail: `Банк ${pot} 🪙 · победителей: ${winners.length}/${lobby.bets.length}`
    });

    const comment = winners.length > 0 ? nextPhrase(chat, 'raceWin') : nextPhrase(chat, 'raceLoss');
    const finalMsg = [
      `🏁 ТАРАКАНЬИ БЕГА — ФИНИШ!`,
      `🏆 Победитель заезда: ${winnerRunner.emoji} ${winnerRunner.name}!`,
      ``,
      renderRaceTracks(lobby.positions, winnerLane),
      ``,
      ...payoutLines,
      ``,
      comment
    ].join('\n');

    await transport.editMessage(
      chat.chatId,
      messageId,
      finalMsg,
      buildPostGameKeyboard('races', lobby.stake, winners.length === 0)
    );

    for (const item of autoCollectQueue) {
      await applyAutoDebtCollection(transport, chat, item.player, item.net);
    }
    for (const zp of zeroOfferQueue) {
      await maybeSendZeroBalanceOffer(transport, chat, zp);
    }
  }
}

// =======================
// SLOT 777 ("ОДНОРУКИЙ ДЯДЯ")
// =======================

const SLOT_SYMBOLS = ['🍫BAR', '🍇', '🍋', '7️⃣'];

async function playSlot777(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  stake: number,
  isLastDodep: boolean,
  existingMsgId?: string
): Promise<void> {
  deductPlayerStake(player, stake);
  scheduleSave();

  const spinBanner = `🎰 ОДНОРУКИЙ ДЯДЯ (СЛОТ 777)\n👤 ${playerLabel(chat, player)} дёргает рычаг на ${stake} 🪙!\n\n⏳ Барабаны раскручиваются...`;
  let panelId = existingMsgId || null;
  if (panelId) {
    await transport.editMessage(chat.chatId, panelId, spinBanner);
  } else {
    panelId = await transport.sendMessage(chat.chatId, spinBanner);
  }

  const slotDice = await transport.sendDice(chat.chatId, '🎰');
  const delay = transport.getRollDelayMs();
  if (delay > 0) await sleep(delay);
  scheduleCleanupMessage(transport, chat.chatId, slotDice.messageId, 8000);

  const v = Math.max(0, Math.min(63, slotDice.value - 1));
  const r0 = v & 3;
  const r1 = (v >> 2) & 3;
  const r2 = (v >> 4) & 3;
  const reels = [r0, r1, r2];
  const reelsDisplay = `[ ${SLOT_SYMBOLS[r0]} | ${SLOT_SYMBOLS[r1]} | ${SLOT_SYMBOLS[r2]} ]`;

  let mult = 0;
  let comboName = 'Мимо';
  let phraseCat: PhraseCategory = 'slotsLoss';

  if (r0 === 3 && r1 === 3 && r2 === 3) {
    mult = 20;
    comboName = 'ДЖЕКПОТ 7️⃣7️⃣7️⃣ (x20)';
    phraseCat = 'slotsJackpot';
  } else if (r0 === r1 && r1 === r2) {
    mult = 7.5;
    comboName = `ТРИ В РЯД ${SLOT_SYMBOLS[r0]} (x7.5)`;
    phraseCat = 'slotsJackpot';
  } else if (reels.filter((x) => x === 3).length === 2) {
    mult = 1.5;
    comboName = 'ДВЕ СЕМЁРКИ 7️⃣7️⃣ (x1.5)';
    phraseCat = 'slotsWin';
  } else if (r0 === r1 || r1 === r2) {
    mult = 0.5;
    comboName = 'ПАРА ПОДРЯД — КЭШБЭК (x0.5)';
    phraseCat = 'slotsWin';
  }

  const payout = Math.round(stake * mult);
  const netProfit = payout - stake;
  const wasLoss = payout < stake;

  player.balance += payout;
  player.lastBetAmount = stake;
  player.lastGameType = 'slots';

  if (payout > stake) {
    player.stats.totalWon += netProfit;
    if (isLastDodep && player.lastActionWasLoss) {
      player.stats.lastDodepWins += 1;
    }
    player.lastActionWasLoss = false;
  } else if (payout < stake) {
    player.stats.totalLost += stake - payout;
    player.lastActionWasLoss = true;
  } else {
    player.lastActionWasLoss = false;
  }
  if (r0 === r1 && r1 === r2) {
    unlockAchievement(chat, player, 'jackpot_777');
  }
  player.lastActionWasLastDodep = false;
  recordGameOutcome(chat, player, 'slots', netProfit, { isLastDodep });
  scheduleSave();

  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: `Слот 777: ${comboName}`,
    detail: `Ставка ${stake} → Выплата ${payout} 🪙 (${reelsDisplay})`
  });

  const outcomeLine =
    payout > stake
      ? `🏆 ${comboName}! Выигрыш: +${payout} фантиков (чистыми +${netProfit})`
      : payout > 0
        ? `⚡ ${comboName}! Вернулось ${payout} из ${stake} фантиков.`
        : `🥀 ПУСТО! Ставка ${stake} фантиков осталась в автомате.`;

  const finalMsg = [
    `🎰 ОДНОРУКИЙ ДЯДЯ — ИТОГ`,
    `👤 Игрок: ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
    ``,
    `🎯 Линия: ${reelsDisplay}`,
    outcomeLine,
    `🪙 Баланс: ${player.balance} фантиков`,
    ``,
    nextPhrase(chat, phraseCat)
  ].join('\n');

  const kb = buildPostGameKeyboard('slots', stake, wasLoss, player);
  if (panelId) {
    await transport.editMessage(chat.chatId, panelId, finalMsg, kb);
  } else {
    await transport.sendMessage(chat.chatId, finalMsg, kb);
  }

  if (netProfit > 0) {
    await applyAutoDebtCollection(transport, chat, player, netProfit);
  }
}

// =======================
// HI-LO ("БОЛЬШЕ / МЕНЬШЕ")
// =======================

function createShuffledHiloDeck(excludeCard?: HiloCard): HiloCard[] {
  const suits = ['♠️', '♥️', '♦️', '♣️'];
  const ranks: { rank: string; rankVal: number }[] = [
    { rank: '2', rankVal: 2 },
    { rank: '3', rankVal: 3 },
    { rank: '4', rankVal: 4 },
    { rank: '5', rankVal: 5 },
    { rank: '6', rankVal: 6 },
    { rank: '7', rankVal: 7 },
    { rank: '8', rankVal: 8 },
    { rank: '9', rankVal: 9 },
    { rank: '10', rankVal: 10 },
    { rank: 'J', rankVal: 11 },
    { rank: 'Q', rankVal: 12 },
    { rank: 'K', rankVal: 13 },
    { rank: 'A', rankVal: 14 }
  ];
  const deck: HiloCard[] = [];
  for (const suit of suits) {
    for (const r of ranks) {
      if (excludeCard && excludeCard.rank === r.rank && excludeCard.suit === suit) continue;
      deck.push({ rank: r.rank, suit, rankVal: r.rankVal });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calcHiloStepMultipliers(current: HiloCard, deck: HiloCard[]): { hiMult: number | null; loMult: number | null } {
  const higher = deck.filter((c) => c.rankVal > current.rankVal).length;
  const lower = deck.filter((c) => c.rankVal < current.rankVal).length;
  const nonTie = higher + lower;
  const hiMult =
    higher > 0 && nonTie > 0
      ? Math.max(1.08, Math.round(((0.96 * nonTie) / higher) * 100) / 100)
      : null;
  const loMult =
    lower > 0 && nonTie > 0
      ? Math.max(1.08, Math.round(((0.96 * nonTie) / lower) * 100) / 100)
      : null;
  return { hiMult, loMult };
}

async function renderHiloState(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  session: HiloSession,
  existingMsgId: string | null,
  subtitle: string
): Promise<void> {
  if (session.deck.length < 5) {
    session.deck = createShuffledHiloDeck(session.currentCard);
  }
  const { hiMult, loMult } = calcHiloStepMultipliers(session.currentCard, session.deck);
  const potentialWin = Math.round(session.stake * session.currentMult);
  const trailStr = session.trail
    .slice(-5)
    .map((c) => `[${c.rank}${c.suit}]`)
    .join(' ▸ ');

  const text = [
    `↕️ БОЛЬШЕ / МЕНЬШЕ (HI-LO)`,
    `👤 Игрок: ${playerLabel(chat, player)} | Ставка: ${session.stake} 🪙`,
    `📈 Серия: ${session.streak} | Множитель: x${session.currentMult.toFixed(2)} (${potentialWin} 🪙)`,
    ``,
    `🃏 Открытая карта: [${session.currentCard.rank}${session.currentCard.suit}]`,
    `📜 Цепочка: ${trailStr}`,
    ``,
    subtitle
  ].join('\n');

  const guessRow: InlineButton[] = [];
  if (hiMult !== null) {
    guessRow.push({ text: `⬆️ Выше (x${hiMult.toFixed(2)})`, callbackData: `hl:hi:${session.id}` });
  }
  if (loMult !== null) {
    guessRow.push({ text: `⬇️ Ниже (x${loMult.toFixed(2)})`, callbackData: `hl:lo:${session.id}` });
  }

  const kb: InlineKeyboard = [guessRow];
  if (session.streak > 0) {
    kb.push([{ text: `💰 Забрать ${potentialWin} 🪙 (x${session.currentMult.toFixed(2)})`, callbackData: `hl:cash:${session.id}` }]);
  }

  if (existingMsgId) {
    await transport.editMessage(chat.chatId, existingMsgId, text, kb);
  } else {
    session.messageId = await transport.sendMessage(chat.chatId, text, kb);
  }
}

async function handleHiloCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];
  const sid = parts[2];
  const session = hiloSessions.get(sid);
  if (!session || session.status !== 'playing') {
    await transport.answerCallback(callbackId, 'Эта партия уже завершена.', true);
    return;
  }
  if (session.userId !== player.userId) {
    await transport.answerCallback(callbackId, 'Не лезь в чужую колоду, кент!', true);
    return;
  }

  if (sub === 'cash') {
    if (session.streak === 0) {
      await transport.answerCallback(callbackId, 'Сначала угадай хотя бы одну карту!', true);
      return;
    }
    session.status = 'finished';
    hiloSessions.delete(sid);

    const payout = Math.round(session.stake * session.currentMult);
    const netProfit = payout - session.stake;
    const wasLoss = payout < session.stake;

    player.balance += payout;
    player.lastBetAmount = session.stake;
    player.lastGameType = 'hilo';
    if (payout > session.stake) {
      player.stats.totalWon += netProfit;
      if (session.isLastDodep && player.lastActionWasLoss) {
        player.stats.lastDodepWins += 1;
      }
      player.lastActionWasLoss = false;
    } else {
      player.lastActionWasLoss = false;
    }
    player.lastActionWasLastDodep = false;
    recordGameOutcome(chat, player, 'hilo', netProfit, { isLastDodep: session.isLastDodep });
    scheduleSave();

    await transport.answerCallback(callbackId, `Забрал ${payout} 🪙 (x${session.currentMult.toFixed(2)})!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: session.userName,
      event: `Hi-Lo: Кэшаут x${session.currentMult.toFixed(2)}`,
      detail: `Серия ${session.streak} → Выигрыш ${payout} 🪙`
    });

    const trailStr = session.trail
      .slice(-6)
      .map((c) => `[${c.rank}${c.suit}]`)
      .join(' ▸ ');

    const finalMsg = [
      `↕️ БОЛЬШЕ / МЕНЬШЕ — КЭШАУТ!`,
      `👤 Игрок: ${playerLabel(chat, player)} | Серия: ${session.streak}`,
      `📜 Карты: ${trailStr}`,
      `🏆 Забрано: +${payout} фантиков (x${session.currentMult.toFixed(2)}, чистыми +${netProfit})`,
      `🪙 Баланс: ${player.balance} фантиков`,
      ``,
      nextPhrase(chat, 'hiloCashout')
    ].join('\n');

    await transport.editMessage(
      chat.chatId,
      messageId,
      finalMsg,
      buildPostGameKeyboard('hilo', session.stake, wasLoss, player)
    );
    if (netProfit > 0) {
      await applyAutoDebtCollection(transport, chat, player, netProfit);
    }
    return;
  }

  if (sub === 'hi' || sub === 'lo') {
    if (session.deck.length < 5) {
      session.deck = createShuffledHiloDeck(session.currentCard);
    }
    const { hiMult, loMult } = calcHiloStepMultipliers(session.currentCard, session.deck);
    const stepFactor = sub === 'hi' ? hiMult : loMult;
    if (!stepFactor) {
      await transport.answerCallback(callbackId, 'Невозможное направление для этой карты!', true);
      return;
    }

    const prevCard = session.currentCard;
    const nextCard = session.deck.pop()!;
    session.trail.push(nextCard);
    session.currentCard = nextCard;

    if (nextCard.rankVal === prevCard.rankVal) {
      await transport.answerCallback(callbackId, `Выпало [${nextCard.rank}${nextCard.suit}] — одинаковый ранг, пронесло!`);
      await renderHiloState(
        transport,
        chat,
        player,
        session,
        messageId,
        `🤝 Выпала [${nextCard.rank}${nextCard.suit}] — ровно такой же номинал, пронесло! Икс сохранён.`
      );
      return;
    }

    const wonStep =
      (sub === 'hi' && nextCard.rankVal > prevCard.rankVal) ||
      (sub === 'lo' && nextCard.rankVal < prevCard.rankVal);

    if (wonStep) {
      session.currentMult = Math.round(session.currentMult * stepFactor * 100) / 100;
      session.streak += 1;
      await transport.answerCallback(
        callbackId,
        `Есть! [${nextCard.rank}${nextCard.suit}] · теперь x${session.currentMult.toFixed(2)}`
      );
      await renderHiloState(transport, chat, player, session, messageId, nextPhrase(chat, 'hiloStep'));
      return;
    }

    // Busted!
    session.status = 'finished';
    hiloSessions.delete(sid);

    player.lastBetAmount = session.stake;
    player.lastGameType = 'hilo';
    player.stats.totalLost += session.stake;
    player.lastActionWasLoss = true;
    player.lastActionWasLastDodep = false;
    recordGameOutcome(chat, player, 'hilo', -session.stake, { isLastDodep: session.isLastDodep });
    scheduleSave();

    await transport.answerCallback(callbackId, `Мимо! Выпала [${nextCard.rank}${nextCard.suit}]!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: session.userName,
      event: `Hi-Lo: Срыв на шаге ${session.streak + 1}`,
      detail: `Была [${prevCard.rank}${prevCard.suit}], вышла [${nextCard.rank}${nextCard.suit}] (-${session.stake} 🪙)`
    });

    const trailStr = session.trail
      .slice(-6)
      .map((c) => `[${c.rank}${c.suit}]`)
      .join(' ▸ ');

    const bustMsg = [
      `💥 БОЛЬШЕ / МЕНЬШЕ — СГОРЕЛ!`,
      `👤 Игрок: ${playerLabel(chat, player)} | Серия оборвалась на шаге ${session.streak + 1}`,
      `📜 Карты: ${trailStr}`,
      `🥀 Сгорело: ${session.stake} фантиков (потенциал был x${session.currentMult.toFixed(2)})`,
      `🪙 Баланс: ${player.balance} фантиков`,
      ``,
      nextPhrase(chat, 'hiloLoss')
    ].join('\n');

    await transport.editMessage(
      chat.chatId,
      messageId,
      bustMsg,
      buildPostGameKeyboard('hilo', session.stake, true, player)
    );
  }
}

// =======================
// TALISMANS & CASES SYSTEM
// =======================

function renderTalismanHubText(chat: ChatState, player: PlayerState): string {
  const col = getPlayerCollectionSummary(player);
  const eqId = player.equippedTalismanId;
  const eqDef = eqId && (player.talismans || []).some((t) => t.talismanId === eqId) ? TALISMAN_BY_ID[eqId] : null;
  const chatUniquesOwned = Object.keys(chat.uniqueTalismans || {}).length;
  const snap = getTalismanIncomeSnapshot(player);

  return [
    `🧳 КЕЙСЫ И ТАЛИСМАНЫ ДЯДИ ДЕПА`,
    `👤 ${playerLabel(chat, player)} | Баланс: ${player.balance} 🪙`,
    ``,
    `🎒 В шкатулке: ${col.count} талисман(ов) (ценность: ${col.recycleTotal} 🪙, уников: ${col.uniqueCount})`,
    `✨ Активный значок: ${eqDef ? `${eqDef.emoji} ${eqDef.name}` : 'не надет'}`,
    `🏦 Доход от талисманов: +${formatHourlyRate(snap.hourlyRate)} 🪙/ч`,
    `💰 Накоплено: ${snap.pendingCoins}/${snap.capCoins} 🪙 (максимум копится 12 часов)${snap.isFull ? ' ✅' : ''}`,
    `🏛️ Уникальных в чате выбито: ${chatUniquesOwned}/${UNIQUE_TALISMANS.length}`,
    ``,
    `Лучшие 8 талисманов приносят доход каждый час (⚪ +3, 🟢 +8, 🟣 +20, 🟡 +50, 🔴 +120 🪙/ч). При просроченном долге 50% сбора уходит в погашение.`
  ].join('\n');
}

function renderTalismanHubKeyboard(chat: ChatState, player: PlayerState): InlineKeyboard {
  const col = getPlayerCollectionSummary(player);
  const chatUniquesOwned = Object.keys(chat.uniqueTalismans || {}).length;
  const snap = getTalismanIncomeSnapshot(player);
  const rows: InlineKeyboard = [
    [
      { text: '🛒 Открыть кейс', callbackData: 'tl:shop' },
      { text: '⚗️ Крафт (5→1)', callbackData: 'tl:craft' }
    ],
    [
      { text: '🍯 Общий Котёл', callbackData: 'pot:menu' },
      { text: '🔨 Аукцион реликвий', callbackData: 'auc:menu' }
    ],
    [
      { text: `🎒 Шкатулка (${col.count})`, callbackData: 'tl:bag:0' },
      { text: `🏛️ Пантеон (${chatUniquesOwned}/${UNIQUE_TALISMANS.length})`, callbackData: 'tl:pantheon' }
    ]
  ];
  if (snap.hourlyRate > 0 || snap.pendingCoins > 0) {
    rows.push([{ text: `💰 Собрать накопленное (+${snap.pendingCoins} 🪙)`, callbackData: 'tl:claim' }]);
  }
  rows.push([{ text: '🏠 В меню', callbackData: 'menu' }]);
  return rows;
}

function renderCaseShopText(chat: ChatState, player: PlayerState): string {
  const lines = [
    `🛒 МАГАЗИН КЕЙСОВ ДЯДИ ДЕПА`,
    `👤 ${playerLabel(chat, player)} | Баланс: ${player.balance} 🪙`,
    ``,
    `Выбирай ящик под свой банкролл:`
  ];
  for (const c of CASE_CATALOG) {
    lines.push(``, `${c.emoji} ${c.name} — ${c.price} 🪙`, `   ${c.description}`, `   Шансы: ${formatCaseOddsLine(c)}`);
  }
  return lines.join('\n');
}

function renderCaseShopKeyboard(): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < CASE_CATALOG.length; i += 2) {
    const pair = CASE_CATALOG.slice(i, i + 2).map((c) => ({
      text: `${c.emoji} ${c.shortName} (${c.price} 🪙)`,
      callbackData: `tl:open:${c.id}`
    }));
    rows.push(pair);
  }
  rows.push([
    { text: '🎒 Моя шкатулка', callbackData: 'tl:bag:0' },
    { text: '↩️ Назад', callbackData: 'tl:menu' }
  ]);
  return rows;
}

function renderChatPantheonText(chat: ChatState): string {
  const registry = chat.uniqueTalismans || {};
  const lines = [
    `🏛️ ПАНТЕОН УНИКАЛЬНЫХ ТАЛИСМАНОВ`,
    `Чат: «${chat.title}» (${Object.keys(registry).length}/${UNIQUE_TALISMANS.length})`,
    `Каждая реликвия существует ровно в 1 экземпляре на чат и не подлежит переработке:`,
    ``
  ];

  for (const u of UNIQUE_TALISMANS) {
    const owner = registry[u.id];
    if (owner) {
      const ownerPlayer = chat.players[owner.ownerId];
      const name = ownerPlayer ? displayName(ownerPlayer) : owner.ownerName;
      lines.push(`${u.emoji} ${u.name} — 🔒 Владелец: ${name}`);
    } else {
      lines.push(`${u.emoji} ${u.name} — 🟢 Свободен (можно выбить!)`);
    }
  }
  return lines.join('\n');
}

function groupPlayerTalismans(player: PlayerState): {
  def: TalismanDef;
  instances: OwnedTalisman[];
}[] {
  const byId = new Map<string, OwnedTalisman[]>();
  for (const item of player.talismans || []) {
    if (!TALISMAN_BY_ID[item.talismanId]) continue;
    const arr = byId.get(item.talismanId) || [];
    arr.push(item);
    byId.set(item.talismanId, arr);
  }
  return [...byId.entries()]
    .map(([tid, instances]) => ({ def: TALISMAN_BY_ID[tid], instances }))
    .sort((a, b) => {
      const ordDiff = RARITY_META[b.def.rarity].order - RARITY_META[a.def.rarity].order;
      if (ordDiff !== 0) return ordDiff;
      return b.def.recycleValue - a.def.recycleValue;
    });
}

function renderTalismanBagView(
  chat: ChatState,
  player: PlayerState,
  pageRaw = 0
): { text: string; keyboard: InlineKeyboard } {
  const grouped = groupPlayerTalismans(player);
  const col = getPlayerCollectionSummary(player);
  const snap = getTalismanIncomeSnapshot(player);
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(grouped.length / pageSize));
  const page = Math.max(0, Math.min(pageRaw, totalPages - 1));
  const slice = grouped.slice(page * pageSize, (page + 1) * pageSize);

  const lines = [
    `🎒 МОЯ КОЛЛЕКЦИЯ ТАЛИСМАНОВ (${col.count} шт. · Ценность: ${col.recycleTotal} 🪙)`,
    `👤 ${playerLabel(chat, player)} | Баланс: ${player.balance} 🪙`,
    `🏦 Доход от талисманов: +${formatHourlyRate(snap.hourlyRate)} 🪙/ч`,
    `💰 Накоплено: ${snap.pendingCoins}/${snap.capCoins} 🪙 (максимум копится 12 часов)${snap.isFull ? ' ✅' : ''}`,
    ``
  ];

  const kb: InlineKeyboard = [];

  if (slice.length === 0) {
    lines.push(`Шкатулка пока пуста! Открывай кейсы и собирай коллекцию.`);
  } else {
    slice.forEach((g, idx) => {
      const num = page * pageSize + idx + 1;
      const meta = RARITY_META[g.def.rarity];
      const isEq = player.equippedTalismanId === g.def.id;
      const eqMark = isEq ? ' ✅[НАДЕТ]' : '';
      const countMark = g.instances.length > 1 ? ` ×${g.instances.length}` : '';
      const baseRate = TALISMAN_INCOME_PER_HOUR[g.def.rarity] || 0;
      const rateInfo = `+${baseRate} 🪙/ч`;
      const sellInfo =
        g.def.rarity === 'unique'
          ? `🔒 только аукцион`
          : `скупка ${g.def.recycleValue} 🪙`;

      lines.push(
        `${num}. ${meta.badge} ${g.def.emoji} ${g.def.name}${countMark}${eqMark}`,
        `   ${meta.label} · ${rateInfo} · ${sellInfo}`
      );

      const priceLabel = g.def.rarity === 'unique' ? '🔒 Уник' : `${g.def.recycleValue} 🪙`;
      kb.push([
        {
          text: `${num}. ${g.def.emoji} ${g.def.name}${countMark}${isEq ? ' ✅' : ''} · ${priceLabel}`,
          callbackData: `tl:item:${g.def.id}:${page}`
        }
      ]);
    });

    lines.push(``, `👆 Нажми на талисман кнопкой ниже — откроется его карточка (надеть, продать или выставить на аукцион).`);
  }

  // Pagination if needed
  if (totalPages > 1) {
    const navRow: InlineButton[] = [];
    if (page > 0) navRow.push({ text: '⬅️ Назад', callbackData: `tl:bag:${page - 1}` });
    navRow.push({ text: `📄 ${page + 1}/${totalPages}`, callbackData: `tl:bag:${page}` });
    if (page < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callbackData: `tl:bag:${page + 1}` });
    kb.push(navRow);
  }

  // Bulk sell actions
  let commonVal = 0;
  let dupesVal = 0;
  for (const g of grouped) {
    if (g.def.rarity === 'common') {
      commonVal += g.def.recycleValue * g.instances.length;
    }
    if (g.def.rarity !== 'unique' && g.instances.length > 1) {
      dupesVal += g.def.recycleValue * (g.instances.length - 1);
    }
  }
  const bulkRow: InlineButton[] = [];
  if (commonVal > 0) {
    bulkRow.push({ text: `💸 Продать все ⚪ (+${commonVal})`, callbackData: 'tl:reccommon' });
  }
  if (dupesVal > 0) {
    bulkRow.push({ text: `💸 Продать все дубли (+${dupesVal})`, callbackData: 'tl:recdupes' });
  }
  if (bulkRow.length > 0) kb.push(bulkRow);

  if (snap.hourlyRate > 0 || snap.pendingCoins > 0) {
    kb.push([{ text: `💰 Собрать накопленное (+${snap.pendingCoins} 🪙)`, callbackData: 'tl:claim' }]);
  }

  kb.push([
    { text: '🛒 Купить кейс', callbackData: 'tl:shop' },
    { text: '⚗️ Крафт (5→1)', callbackData: 'tl:craft' },
    { text: '↩️ Назад', callbackData: 'menu:talismans' }
  ]);

  return { text: lines.join('\n'), keyboard: kb };
}

function renderTalismanItemView(
  chat: ChatState,
  player: PlayerState,
  talismanId: string,
  returnPage = 0
): { text: string; keyboard: InlineKeyboard } | null {
  const def = TALISMAN_BY_ID[talismanId];
  if (!def) return null;

  const instances = (player.talismans || []).filter((t) => t.talismanId === talismanId);
  if (instances.length === 0) return null;

  const meta = RARITY_META[def.rarity];
  const isEq = player.equippedTalismanId === def.id;
  const baseRate = TALISMAN_INCOME_PER_HOUR[def.rarity] || 0;
  const firstInst = instances[0];

  const lines = [
    `${meta.badge} ${def.emoji} ${def.name.toUpperCase()}`,
    `👤 ${playerLabel(chat, player)} | Баланс: ${player.balance} 🪙`,
    ``,
    `• Редкость: ${meta.label}`,
    `• В коллекции: ${instances.length} шт.`,
    `• Значок: ${isEq ? '✅ надет (отображается у ника)' : 'не надет'}`,
    `• Доход от талисмана: +${baseRate} 🪙/ч`,
    def.rarity === 'unique'
      ? `• Быстрая продажа: 🔒 недоступна (уник 1/1 на чат — продаётся только через Аукцион)`
      : `• Быстрая продажа (скупщику): +${def.recycleValue} 🪙 за 1 шт.`,
    ``,
    `📜 «${def.lore}»`
  ];

  const kb: InlineKeyboard = [
    [
      {
        text: isEq ? '🔽 Снять значок' : '✨ Надеть как значок',
        callbackData: `tl:eq:${def.id}:item_${returnPage}`
      }
    ]
  ];

  if (def.rarity !== 'unique') {
    const sellRow: InlineButton[] = [
      {
        text: `💸 Продать 1 шт. (+${def.recycleValue} 🪙)`,
        callbackData: `tl:rec:${firstInst.instanceId}:item_${returnPage}`
      }
    ];
    if (instances.length > 1) {
      const extraCount = instances.length - 1;
      const extraVal = extraCount * def.recycleValue;
      sellRow.push({
        text: `♻️ Продать дубли (${extraCount} шт. = +${extraVal})`,
        callbackData: `tl:recitemdupes:${def.id}:${returnPage}`
      });
    }
    kb.push(sellRow);
  }

  kb.push([
    {
      text: '🔨 Выставить 1 шт. на аукцион',
      callbackData: `auc:price:${firstInst.instanceId}`
    }
  ]);

  kb.push([
    { text: '⬅️ К коллекции', callbackData: `tl:bag:${returnPage}` },
    { text: '🧳 Талисманы', callbackData: 'menu:talismans' }
  ]);

  return { text: lines.join('\n'), keyboard: kb };
}

async function openCaseForPlayer(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  caseDef: CaseDef
): Promise<void> {
  if (player.balance < caseDef.price) {
    await transport.answerCallback(
      callbackId,
      `Не хватает фантиков! Нужно ${caseDef.price} 🪙, у тебя ${player.balance} 🪙.`,
      true
    );
    return;
  }

  await transport.answerCallback(callbackId, `Открываем ${caseDef.name}...`);

  player.balance -= caseDef.price;
  player.stats.casesOpened = (player.stats.casesOpened || 0) + 1;

  // Roll rarity & pick talisman
  let rolledRarity = rollRarityForCase(caseDef);
  let allUniquesTakenNotice = false;
  let dropped: TalismanDef;

  if (rolledRarity === 'unique') {
    const registry = chat.uniqueTalismans || {};
    const availableUniques = UNIQUE_TALISMANS.filter((u) => !registry[u.id]);
    if (availableUniques.length > 0) {
      dropped = availableUniques[Math.floor(Math.random() * availableUniques.length)];
      if (!chat.uniqueTalismans) chat.uniqueTalismans = {};
      chat.uniqueTalismans[dropped.id] = {
        ownerId: player.userId,
        ownerName: displayName(player),
        obtainedAt: Date.now()
      };
    } else {
      allUniquesTakenNotice = true;
      rolledRarity = 'legendary';
      const legends = getTalismansByRarity('legendary');
      dropped = legends[Math.floor(Math.random() * legends.length)];
    }
  } else {
    const pool = getTalismansByRarity(rolledRarity);
    dropped = pool[Math.floor(Math.random() * pool.length)];
  }

  const instance: OwnedTalisman = {
    instanceId: shortId(),
    talismanId: dropped.id,
    obtainedAt: Date.now()
  };
  syncTalismanPassiveIncome(player);
  if (!player.talismans) player.talismans = [];
  player.talismans.push(instance);
  recordQuestProgress(player, 'case_or_craft', 1);
  if (dropped.rarity === 'unique') {
    unlockAchievement(chat, player, 'collector_unique');
  }
  scheduleSave();

  // Animated roulette strip (2 fast frames before reveal)
  const spinDelay = transport.source === 'telegram' ? 520 : 320;
  const sampleEmojis = TALISMAN_CATALOG.map((t) => t.emoji);
  const pickRandEmoji = () => sampleEmojis[Math.floor(Math.random() * sampleEmojis.length)];

  await transport.editMessage(
    chat.chatId,
    messageId,
    [
      `${caseDef.emoji} ОТКРЫТИЕ: ${caseDef.name}`,
      `👤 ${playerLabel(chat, player)} | Списано: ${caseDef.price} 🪙`,
      ``,
      `🎰 Лента крутится...`,
      `[ ${pickRandEmoji()} | ${pickRandEmoji()} | ▸ ${pickRandEmoji()} ◂ | ${pickRandEmoji()} | ${pickRandEmoji()} ]`
    ].join('\n'),
    undefined,
    { isAnimation: true }
  );
  await sleep(spinDelay);

  await transport.editMessage(
    chat.chatId,
    messageId,
    [
      `${caseDef.emoji} ОТКРЫТИЕ: ${caseDef.name}`,
      `👤 ${playerLabel(chat, player)}`,
      ``,
      `⏳ Лента замедляется...`,
      `[ ${pickRandEmoji()} | ${pickRandEmoji()} | ▸ ${dropped.emoji} ◂ | ${pickRandEmoji()} | ${pickRandEmoji()} ]`
    ].join('\n'),
    undefined,
    { isAnimation: true }
  );
  await sleep(spinDelay);

  const meta = RARITY_META[dropped.rarity];
  const quoteCat: PhraseCategory =
    dropped.rarity === 'legendary' || dropped.rarity === 'unique'
      ? 'talismanDropLegendUnique'
      : dropped.rarity === 'rare' || dropped.rarity === 'epic'
        ? 'talismanDropRareEpic'
        : 'talismanDropCommon';
  const phrase = nextPhrase(chat, quoteCat);

  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: `Кейс «${caseDef.shortName}»`,
    detail: `Выпал ${meta.badge} ${dropped.emoji} ${dropped.name} (${meta.label})`
  });

  const valueLine =
    dropped.rarity === 'unique'
      ? `🔒 Уникальная реликвия (1 из 1 на чат) — переработка запрещена!`
      : `♻️ Переработка: ${dropped.recycleValue} 🪙`;

  const resultLines = [
    `${caseDef.emoji} КЕЙС ОТКРЫТ — ${meta.badge} ${meta.label.toUpperCase()}!`,
    `👤 Игрок: ${playerLabel(chat, player)}`,
    ``,
    `🎁 Выпал талисман: ${dropped.emoji} ${dropped.name}`,
    `📜 «${dropped.lore}»`,
    valueLine,
    ...(allUniquesTakenNotice
      ? [`⚠️ Все 7 Уникальных реликвий чата уже разобраны — выдана элитная Легендарка!`]
      : []),
    `🪙 Баланс: ${player.balance} фантиков`,
    ``,
    phrase
  ];

  const actionRow: InlineButton[] = [
    { text: `✨ Надеть (${dropped.emoji})`, callbackData: `tl:eq:${dropped.id}:drop` }
  ];
  if (dropped.rarity !== 'unique') {
    actionRow.push({
      text: `♻️ Переработать (+${dropped.recycleValue})`,
      callbackData: `tl:rec:${instance.instanceId}:drop`
    });
  }

  const kb: InlineKeyboard = [
    actionRow,
    [{ text: `🔁 Ещё «${caseDef.shortName}» (${caseDef.price} 🪙)`, callbackData: `tl:open:${caseDef.id}` }],
    [
      { text: '🎒 Шкатулка', callbackData: 'tl:bag:0' },
      { text: '🏠 В меню', callbackData: 'menu' }
    ]
  ];

  await transport.editMessage(chat.chatId, messageId, resultLines.join('\n'), kb);
}

async function handleTalismanCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1] || 'menu';

  if (sub === 'menu') {
    await transport.answerCallback(callbackId);
    await transport.editMessage(
      chat.chatId,
      messageId,
      renderTalismanHubText(chat, player),
      renderTalismanHubKeyboard(chat, player)
    );
    return;
  }

  if (sub === 'claim') {
    const res = claimTalismanPassiveIncome(transport, chat, player);
    if (!res.ok) {
      await transport.answerCallback(callbackId, res.reason || 'Копилка пока пуста.', true);
      return;
    }

    await transport.answerCallback(
      callbackId,
      res.debtCollected > 0
        ? `🏦 Собрано ${res.collected} 🪙 (на руки +${res.netReceived}, в долг -${res.debtCollected})`
        : `🏦 Собрано +${res.netReceived} 🪙!`
    );

    const lines = [
      `🏦 РЕНТА ШКАТУЛКИ СОБРАНА!`,
      `👤 ${playerLabel(chat, player)}`,
      ``,
      `💰 Накоплено талисманами: ${res.collected} 🪙`
    ];

    if (res.debtCollected > 0) {
      lines.push(
        `💼 Просроченный долг — коллектор удержал 50% (-${res.debtCollected} 🪙):`,
        ...res.collectedLines,
        `✅ Чистыми на баланс: +${res.netReceived} 🪙`
      );
    } else {
      lines.push(`✅ Вся сумма зачислена на баланс: +${res.netReceived} 🪙`);
    }

    lines.push(
      `🪙 Текущий баланс: ${player.balance} фантиков`,
      `🏦 Доход от талисманов: +${formatHourlyRate(res.snapshot.hourlyRate)} 🪙/ч (максимум копится 12 часов — до ${res.snapshot.capCoins} 🪙)`
    );

    const kb: InlineKeyboard = [
      [
        { text: '🎒 Моя шкатулка', callbackData: 'tl:bag:0' },
        { text: '🧳 Талисманы', callbackData: 'menu:talismans' }
      ],
      [{ text: '🏠 В меню', callbackData: 'menu:home' }]
    ];

    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, lines.join('\n'), kb);
    } else {
      await transport.sendMessage(chat.chatId, lines.join('\n'), kb);
    }
    return;
  }

  if (sub === 'shop') {
    await transport.answerCallback(callbackId);
    await transport.editMessage(
      chat.chatId,
      messageId,
      renderCaseShopText(chat, player),
      renderCaseShopKeyboard()
    );
    return;
  }

  if (sub === 'pantheon') {
    await transport.answerCallback(callbackId);
    await transport.editMessage(chat.chatId, messageId, renderChatPantheonText(chat), [
      [
        { text: '🛒 Купить кейс', callbackData: 'tl:shop' },
        { text: '↩️ Назад', callbackData: 'tl:menu' }
      ]
    ]);
    return;
  }

  if (sub === 'bag') {
    const page = parseInt(parts[2] || '0', 10) || 0;
    await transport.answerCallback(callbackId);
    const view = renderTalismanBagView(chat, player, page);
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'item') {
    const tid = parts[2];
    const page = parseInt(parts[3] || '0', 10) || 0;
    const itemView = renderTalismanItemView(chat, player, tid, page);
    if (!itemView) {
      await transport.answerCallback(callbackId, 'Этот талисман больше не найден в шкатулке.', true);
      const bagView = renderTalismanBagView(chat, player, page);
      await transport.editMessage(chat.chatId, messageId, bagView.text, bagView.keyboard);
      return;
    }
    await transport.answerCallback(callbackId);
    await transport.editMessage(chat.chatId, messageId, itemView.text, itemView.keyboard);
    return;
  }

  if (sub === 'open') {
    const caseId = parts[2];
    const caseDef = CASE_BY_ID[caseId];
    if (!caseDef) {
      await transport.answerCallback(callbackId, 'Неизвестный кейс', true);
      return;
    }
    await openCaseForPlayer(transport, chat, player, callbackId, messageId, caseDef);
    return;
  }

  if (sub === 'eq') {
    const tid = parts[2];
    const context = parts[3] || '0';
    const def = TALISMAN_BY_ID[tid];
    const owned = (player.talismans || []).some((t) => t.talismanId === tid);
    if (!def || !owned) {
      await transport.answerCallback(callbackId, 'У тебя нет этого талисмана в шкатулке!', true);
      return;
    }
    if (player.equippedTalismanId === tid) {
      player.equippedTalismanId = null;
      scheduleSave();
      await transport.answerCallback(callbackId, `Снят значок ${def.emoji} ${def.name}`);
    } else {
      player.equippedTalismanId = tid;
      scheduleSave();
      await transport.answerCallback(callbackId, `Надет значок ${def.emoji} ${def.name}!`);
    }

    if (context.startsWith('item_')) {
      const returnPage = parseInt(context.slice(5), 10) || 0;
      const itemView = renderTalismanItemView(chat, player, tid, returnPage);
      if (itemView) {
        await transport.editMessage(chat.chatId, messageId, itemView.text, itemView.keyboard);
        return;
      }
    }

    if (context === 'drop') {
      const view = renderTalismanBagView(chat, player, 0);
      await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    } else {
      const page = parseInt(context, 10) || 0;
      const view = renderTalismanBagView(chat, player, page);
      await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    }
    return;
  }

  if (sub === 'rec') {
    const instanceId = parts[2];
    const context = parts[3] || '0';
    const list = player.talismans || [];
    const idx = list.findIndex((t) => t.instanceId === instanceId);
    if (idx === -1) {
      await transport.answerCallback(callbackId, 'Этот талисман уже продан или не найден!', true);
      return;
    }
    const item = list[idx];
    const def = TALISMAN_BY_ID[item.talismanId];
    if (!def) {
      await transport.answerCallback(callbackId, 'Талисман не найден', true);
      return;
    }
    if (def.rarity === 'unique' || def.recycleValue <= 0) {
      await transport.answerCallback(
        callbackId,
        '🔒 Уникальный талисман (1/1 на чат) скупщику продать НЕЛЬЗЯ — только через Аукцион!',
        true
      );
      return;
    }

    syncTalismanPassiveIncome(player);
    list.splice(idx, 1);
    player.talismans = list;
    player.balance += def.recycleValue;
    player.stats.talismansRecycledValue = (player.stats.talismansRecycledValue || 0) + def.recycleValue;

    if (player.equippedTalismanId === def.id && !list.some((t) => t.talismanId === def.id)) {
      player.equippedTalismanId = null;
    }
    scheduleSave();

    await transport.answerCallback(callbackId, `💸 Продано! +${def.recycleValue} 🪙 за ${def.emoji} ${def.name}`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'Продажа талисмана скупщику',
      detail: `${def.emoji} ${def.name} → +${def.recycleValue} 🪙`
    });

    if (context === 'drop') {
      const quote = nextPhrase(chat, 'talismanRecycle');
      await transport.editMessage(
        chat.chatId,
        messageId,
        [
          `💸 ТАЛИСМАН ПРОДАН СКУПЩИКУ`,
          `👤 ${playerLabel(chat, player)}`,
          ``,
          `Продано: ${def.emoji} ${def.name}`,
          `💰 Получено: +${def.recycleValue} 🪙`,
          `🪙 Новый баланс: ${player.balance} фантиков`,
          ``,
          quote
        ].join('\n'),
        [
          [
            { text: '🛒 Купить кейс', callbackData: 'tl:shop' },
            { text: '🎒 Шкатулка', callbackData: 'tl:bag:0' }
          ],
          [{ text: '🏠 В меню', callbackData: 'menu' }]
        ]
      );
    } else if (context.startsWith('item_')) {
      const returnPage = parseInt(context.slice(5), 10) || 0;
      const itemView = renderTalismanItemView(chat, player, def.id, returnPage);
      if (itemView) {
        await transport.editMessage(chat.chatId, messageId, itemView.text, itemView.keyboard);
      } else {
        const bagView = renderTalismanBagView(chat, player, returnPage);
        await transport.editMessage(chat.chatId, messageId, bagView.text, bagView.keyboard);
      }
    } else {
      const page = parseInt(context, 10) || 0;
      const view = renderTalismanBagView(chat, player, page);
      await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    }
    return;
  }

  if (sub === 'recitemdupes') {
    const tid = parts[2];
    const returnPage = parseInt(parts[3] || '0', 10) || 0;
    const def = TALISMAN_BY_ID[tid];
    if (!def || def.rarity === 'unique' || def.recycleValue <= 0) {
      await transport.answerCallback(callbackId, 'Этот талисман нельзя продать скупщику.', true);
      return;
    }
    const list = player.talismans || [];
    let keptFirst = false;
    let soldCount = 0;
    let earned = 0;
    const nextList: OwnedTalisman[] = [];
    for (const item of list) {
      if (item.talismanId === tid) {
        if (!keptFirst) {
          keptFirst = true;
          nextList.push(item);
        } else {
          soldCount += 1;
          earned += def.recycleValue;
        }
      } else {
        nextList.push(item);
      }
    }
    if (soldCount === 0) {
      await transport.answerCallback(callbackId, 'Дублей этого талисмана нет!', true);
      return;
    }

    syncTalismanPassiveIncome(player);
    player.talismans = nextList;
    player.balance += earned;
    player.stats.talismansRecycledValue = (player.stats.talismansRecycledValue || 0) + earned;
    scheduleSave();

    await transport.answerCallback(
      callbackId,
      `💸 Продано ${soldCount} дубл. ${def.emoji} ${def.name} (+${earned} 🪙)`
    );
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'Продажа дублей талисмана',
      detail: `${def.emoji} ${def.name} ×${soldCount} → +${earned} 🪙`
    });

    const itemView = renderTalismanItemView(chat, player, tid, returnPage);
    if (itemView) {
      await transport.editMessage(chat.chatId, messageId, itemView.text, itemView.keyboard);
    } else {
      const bagView = renderTalismanBagView(chat, player, returnPage);
      await transport.editMessage(chat.chatId, messageId, bagView.text, bagView.keyboard);
    }
    return;
  }

  if (sub === 'reccommon' || sub === 'recdupes') {
    const list = player.talismans || [];
    const seen = new Set<string>();
    const kept: OwnedTalisman[] = [];
    let recycledCount = 0;
    let earned = 0;

    for (const item of list) {
      const def = TALISMAN_BY_ID[item.talismanId];
      if (!def || def.rarity === 'unique') {
        kept.push(item);
        continue;
      }
      if (sub === 'reccommon') {
        if (def.rarity === 'common') {
          recycledCount += 1;
          earned += def.recycleValue;
        } else {
          kept.push(item);
        }
      } else {
        // recdupes: keep first copy of each type, recycle extras
        if (seen.has(def.id)) {
          recycledCount += 1;
          earned += def.recycleValue;
        } else {
          seen.add(def.id);
          kept.push(item);
        }
      }
    }

    if (recycledCount === 0) {
      await transport.answerCallback(callbackId, 'Нечего продавать!', true);
      return;
    }

    syncTalismanPassiveIncome(player);
    player.talismans = kept;
    player.balance += earned;
    player.stats.talismansRecycledValue = (player.stats.talismansRecycledValue || 0) + earned;
    if (
      player.equippedTalismanId &&
      !kept.some((t) => t.talismanId === player.equippedTalismanId)
    ) {
      player.equippedTalismanId = null;
    }
    scheduleSave();

    await transport.answerCallback(callbackId, `💸 Продано ${recycledCount} шт. (+${earned} 🪙)`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: sub === 'reccommon' ? 'Массовая продажа Дефолтов' : 'Продажа дублей талисманов',
      detail: `${recycledCount} шт. → +${earned} 🪙`
    });

    const view = renderTalismanBagView(chat, player, 0);
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'craft') {
    await transport.answerCallback(callbackId);
    const view = renderTalismanCraftView(chat, player);
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'craftdo') {
    const srcRarity = parts[2] as 'common' | 'rare' | 'epic';
    const nextMap: Record<'common' | 'rare' | 'epic', TalismanRarity> = {
      common: 'rare',
      rare: 'epic',
      epic: 'legendary'
    };
    const targetRarity = nextMap[srcRarity];
    if (!targetRarity) {
      await transport.answerCallback(callbackId, 'Этот уровень нельзя скрафтить!', true);
      return;
    }

    const list = player.talismans || [];
    const matching = list.filter((t) => TALISMAN_BY_ID[t.talismanId]?.rarity === srcRarity);
    if (matching.length < 5) {
      await transport.answerCallback(callbackId, `Нужно 5 шт. этого класса, а у тебя ${matching.length}!`, true);
      return;
    }

    // Sacrifice non-equipped copies first so equipped talisman stays intact if possible
    syncTalismanPassiveIncome(player);
    const eqId = player.equippedTalismanId;
    const orderedCandidates = [
      ...matching.filter((t) => t.talismanId !== eqId),
      ...matching.filter((t) => t.talismanId === eqId)
    ];
    const toConsumeIds = new Set(orderedCandidates.slice(0, 5).map((t) => t.instanceId));
    player.talismans = list.filter((t) => !toConsumeIds.has(t.instanceId));
    if (eqId && !player.talismans.some((t) => t.talismanId === eqId)) {
      player.equippedTalismanId = null;
    }

    const pool = getTalismansByRarity(targetRarity);
    const crafted = pool[Math.floor(Math.random() * pool.length)];
    const craftedInst: OwnedTalisman = {
      instanceId: shortId(),
      talismanId: crafted.id,
      obtainedAt: Date.now()
    };
    player.talismans.push(craftedInst);
    player.stats.craftsDone = (player.stats.craftsDone || 0) + 1;
    recordQuestProgress(player, 'case_or_craft', 1);
    unlockAchievement(chat, player, 'alchemist');
    scheduleSave();

    const srcMeta = RARITY_META[srcRarity];
    const tgtMeta = RARITY_META[targetRarity];
    await transport.answerCallback(callbackId, `⚗️ Скрафчено: ${crafted.emoji} ${crafted.name}!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: `Крафт 5→1 (${srcMeta.label} → ${tgtMeta.label})`,
      detail: `Получен ${crafted.emoji} ${crafted.name}`
    });

    await transport.editMessage(
      chat.chatId,
      messageId,
      [
        `⚗️ КОНТРАКТ КРАФТА (5 → 1) ВЫПОЛНЕН!`,
        `👤 ${playerLabel(chat, player)}`,
        ``,
        `🔥 Переплавлено: 5 × ${srcMeta.badge} ${srcMeta.label}`,
        `✨ Результат: ${tgtMeta.badge} ${crafted.emoji} ${crafted.name} (${tgtMeta.label})`,
        `📜 «${crafted.lore}»`,
        `♻️ Переработка: ${crafted.recycleValue} 🪙`,
        ``,
        nextPhrase(chat, 'talismanCraft')
      ].join('\n'),
      [
        [
          { text: `✨ Надеть (${crafted.emoji})`, callbackData: `tl:eq:${crafted.id}:drop` },
          { text: '⚗️ Ещё крафт', callbackData: 'tl:craft' }
        ],
        [
          { text: '🎒 Шкатулка', callbackData: 'tl:bag:0' },
          { text: '🏠 В меню', callbackData: 'menu' }
        ]
      ]
    );
    return;
  }

  await transport.answerCallback(callbackId);
}

function renderTalismanCraftView(chat: ChatState, player: PlayerState): { text: string; keyboard: InlineKeyboard } {
  const list = player.talismans || [];
  const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
  for (const item of list) {
    const r = TALISMAN_BY_ID[item.talismanId]?.rarity;
    if (r === 'common' || r === 'rare' || r === 'epic' || r === 'legendary') {
      counts[r] += 1;
    }
  }

  const lines = [
    `⚗️ ПОДПОЛЬНЫЙ КРАФТ ТАЛИСМАНОВ (5 → 1)`,
    `👤 ${playerLabel(chat, player)} | Всего в шкатулке: ${list.length} шт.`,
    ``,
    `Переплавь 5 талисманов одной редкости в 1 гарантированный талисман уровнем выше:`,
    `• ⚪ 5 Дефолтных → 🟢 1 Редкий (у тебя: ${counts.common}/5)`,
    `• 🟢 5 Редких → 🟣 1 Эпический (у тебя: ${counts.rare}/5)`,
    `• 🟣 5 Эпических → 🟡 1 Легендарный (у тебя: ${counts.epic}/5)`,
    ``,
    `ℹ️ 🔴 Уникальные реликвии (1/1 на чат) через крафт не создаются — их можно только выбить из кейса или отжать в Котле!`
  ];

  const kb: InlineKeyboard = [];
  if (counts.common >= 5) {
    kb.push([{ text: `⚗️ 5 ⚪ → 1 🟢 Редкий (${counts.common} шт.)`, callbackData: 'tl:craftdo:common' }]);
  }
  if (counts.rare >= 5) {
    kb.push([{ text: `⚗️ 5 🟢 → 1 🟣 Эпический (${counts.rare} шт.)`, callbackData: 'tl:craftdo:rare' }]);
  }
  if (counts.epic >= 5) {
    kb.push([{ text: `⚗️ 5 🟣 → 1 🟡 Легендарный (${counts.epic} шт.)`, callbackData: 'tl:craftdo:epic' }]);
  }
  kb.push([
    { text: '🛒 Купить кейс', callbackData: 'tl:shop' },
    { text: '🎒 Шкатулка', callbackData: 'tl:bag:0' },
    { text: '↩️ Назад', callbackData: 'tl:menu' }
  ]);

  return { text: lines.join('\n'), keyboard: kb };
}

// =======================
// DUEL 1V1 (HEADS / TAILS PvP)
// =======================

async function handleDuelCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];

  if (sub === 'new') {
    const side = parts[2] === 'tails' ? 'tails' : 'heads';
    const stake = parseInt(parts[3], 10);
    const isLastDodep = parts[4] === '1';

    if (!Number.isFinite(stake) || stake <= 0 || player.balance < stake) {
      await transport.answerCallback(callbackId, 'Недостаточно фантиков для вызова!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `Призрак чата: жди ${formatDuration(ghostMs)}`, true);
      return;
    }

    deductPlayerStake(player, stake);
    scheduleSave();

    const sid = shortId();
    const lobby: DuelLobby = {
      id: sid,
      chatId: chat.chatId,
      creatorId: player.userId,
      creatorName: displayName(player),
      creatorSide: side,
      stake,
      isLastDodep,
      status: 'waiting',
      messageId: messageId || null,
      transportSource: transport.source,
      transport,
      createdAt: Date.now()
    };
    duelLobbies.set(sid, lobby);
    markRuntimeDirty();

    const creatorSideLabel = side === 'heads' ? '🦅 Орёл' : '🪙 Решка';
    const oppSideLabel = side === 'heads' ? '🪙 Решка' : '🦅 Орёл';

    const text = [
      `🪙 ДУЭЛЬ 1 НА 1 — ЖДЁМ СОПЕРНИКА!`,
      `⚔️ Вызов кинул: ${playerLabel(chat, player)}`,
      `🎯 Сторона создателя: ${creatorSideLabel}`,
      `🆚 Сопернику достаётся: ${oppSideLabel}`,
      `💵 Ставка: ${stake} 🪙 | 💰 Банк на двоих: ${stake * 2} 🪙`,
      ``,
      `Кто примет бой 1 на 1? Жми кнопку ниже 👇`
    ].join('\n');
    const kb: InlineKeyboard = [
      [{ text: `⚔️ Принять вызов (${oppSideLabel} · ${stake} 🪙)`, callbackData: `dl:join:${sid}` }],
      [{ text: '❌ Отменить вызов', callbackData: `dl:stop:${sid}` }]
    ];

    await transport.answerCallback(callbackId, 'Вызов на дуэль брошен!');
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, text, kb);
    } else {
      lobby.messageId = await transport.sendMessage(chat.chatId, text, kb);
    }
    return;
  }

  if (sub === 'stop') {
    const sid = parts[2];
    const lobby = duelLobbies.get(sid);
    if (!lobby || lobby.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Дуэль уже началась или отменена.', true);
      return;
    }
    if (lobby.creatorId !== player.userId) {
      await transport.answerCallback(callbackId, 'Отменить дуэль может только её создатель!', true);
      return;
    }

    lobby.status = 'finished';
    duelLobbies.delete(sid);
    player.balance += lobby.stake;
    player.stats.gamesPlayed = Math.max(0, player.stats.gamesPlayed - 1);
    scheduleSave();

    await transport.answerCallback(callbackId, `Вызов отменён, ${lobby.stake} 🪙 возвращены.`);
    await transport.editMessage(
      chat.chatId,
      lobby.messageId || messageId,
      `❌ Дуэль 1×1 от ${playerLabel(chat, player)} отменена. Ставка ${lobby.stake} 🪙 возвращена.`,
      [[{ text: '🏠 В меню', callbackData: 'menu' }]]
    );
    return;
  }

  if (sub === 'join') {
    const sid = parts[2];
    const lobby = duelLobbies.get(sid);
    if (!lobby || lobby.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Дуэль уже завершилась или кто-то опередил!', true);
      return;
    }
    if (lobby.creatorId === player.userId) {
      await transport.answerCallback(callbackId, 'Самому с собой дуэлиться нельзя, кент!', true);
      return;
    }
    if (player.balance < lobby.stake) {
      await transport.answerCallback(callbackId, `Нужно ${lobby.stake} 🪙, у тебя ${player.balance} 🪙.`, true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `Ты Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }

    lobby.status = 'flipping';
    const oppIsLastDodep = player.lastActionWasLastDodep;
    deductPlayerStake(player, lobby.stake);
    scheduleSave();

    const targetMsgId = lobby.messageId || messageId;
    await transport.answerCallback(callbackId, 'Вызов принят! Монета летит...');

    const stepDelay = transport.source === 'telegram' ? 650 : 380;
    const creator = chat.players[lobby.creatorId];
    const creatorLabel = creator ? playerLabel(chat, creator) : lobby.creatorName;
    const oppLabel = playerLabel(chat, player);
    const creatorSideLabel = lobby.creatorSide === 'heads' ? '🦅 Орёл' : '🪙 Решка';
    const oppSideLabel = lobby.creatorSide === 'heads' ? '🪙 Решка' : '🦅 Орёл';

    await transport.editMessage(
      chat.chatId,
      targetMsgId,
      [
        `🪙 ДУЭЛЬ 1 НА 1 — МОНЕТА В ВОЗДУХЕ!`,
        `${creatorSideLabel}: ${creatorLabel}`,
        `${oppSideLabel}: ${oppLabel}`,
        `💰 На кону: ${lobby.stake * 2} 🪙`,
        ``,
        `💫 Дядя Деп подкинул пятак... крутится!`
      ].join('\n'),
      undefined,
      { isAnimation: true }
    );
    await sleep(stepDelay);

    await transport.editMessage(
      chat.chatId,
      targetMsgId,
      [
        `🪙 ДУЭЛЬ 1 НА 1 — МОМЕНТ ИСТИНЫ!`,
        `${creatorSideLabel}: ${creatorLabel}`,
        `${oppSideLabel}: ${oppLabel}`,
        ``,
        `⚡ Щёлкнула о стол...`
      ].join('\n'),
      undefined,
      { isAnimation: true }
    );
    await sleep(stepDelay);

    const outcome: 'heads' | 'tails' = Math.random() < 0.5 ? 'heads' : 'tails';
    const outcomeLabel = outcome === 'heads' ? '🦅 ОРЁЛ' : '🪙 РЕШКА';
    const creatorWon = outcome === lobby.creatorSide;

    const winner = creatorWon ? creator || player : player;
    const loser = creatorWon ? player : creator;
    const winnerIsLd = creatorWon ? lobby.isLastDodep : oppIsLastDodep;
    const pot = lobby.stake * 2;

    winner.balance += pot;
    winner.lastBetAmount = lobby.stake;
    winner.lastGameType = 'duel';
    winner.stats.totalWon += lobby.stake;
    if (winnerIsLd && winner.lastActionWasLoss) {
      winner.stats.lastDodepWins += 1;
    }
    winner.lastActionWasLoss = false;
    winner.lastActionWasLastDodep = false;

    if (loser) {
      loser.lastBetAmount = lobby.stake;
      loser.lastGameType = 'duel';
      loser.stats.totalLost += lobby.stake;
      loser.lastActionWasLoss = true;
      loser.lastActionWasLastDodep = false;
    }

    lobby.status = 'finished';
    duelLobbies.delete(sid);
    recordGameOutcome(chat, winner, 'duel', lobby.stake, { isLastDodep: winnerIsLd });
    if (loser) {
      recordGameOutcome(chat, loser, 'duel', -lobby.stake);
    }
    scheduleSave();

    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(winner),
      event: `Дуэль 1×1: выпал ${outcomeLabel}`,
      detail: `${displayName(winner)} победил ${loser ? displayName(loser) : 'соперника'} (+${pot} 🪙)`
    });

    const finalMsg = [
      `🪙 ДУЭЛЬ 1 НА 1 — ИТОГ!`,
      `Выпало: ${outcomeLabel}!`,
      ``,
      `🏆 Победитель: ${playerLabel(chat, winner)} забирает весь банк +${pot} 🪙 (чистыми +${lobby.stake})!`,
      `🥀 Проигравший: ${loser ? playerLabel(chat, loser) : 'соперник'} (-${lobby.stake} 🪙)`,
      ``,
      nextPhrase(chat, 'duelWin')
    ].join('\n');

    await transport.editMessage(
      chat.chatId,
      targetMsgId,
      finalMsg,
      buildPostGameKeyboard('duel', lobby.stake, false)
    );

    await applyAutoDebtCollection(transport, chat, winner, lobby.stake);
    if (loser && loser.balance === 0) {
      await maybeSendZeroBalanceOffer(transport, chat, loser);
    }
    return;
  }

  await transport.answerCallback(callbackId);
}

// =======================
// LADDER ("ЛЕСЕНКА ДОДЕПА")
// =======================

const LADDER_MULTIPLIERS: Record<'easy' | 'hard', number[]> = {
  easy: [1.44, 2.16, 3.24, 4.86, 7.29, 10.94],
  hard: [2.88, 8.64, 25.92, 77.76, 233.28, 699.84]
};

function renderLadderBoard(session: LadderSession, revealAll = false, bustedCol?: number): string {
  const mults = LADDER_MULTIPLIERS[session.mode];
  const lines: string[] = [];

  for (let f = 5; f >= 0; f--) {
    const floorNum = f + 1;
    const mult = mults[f];
    const row = session.floors[f];
    const cells: string[] = [];

    for (let c = 0; c < 3; c++) {
      if (f < session.floor) {
        if (session.pickedCols[f] === c) {
          cells.push('🧗');
        } else {
          cells.push(row[c] === 1 ? '✅' : '💣');
        }
      } else if (revealAll) {
        if (f === session.floor && bustedCol === c) {
          cells.push('💥');
        } else {
          cells.push(row[c] === 1 ? '✅' : '💣');
        }
      } else if (f === session.floor) {
        cells.push(`🚪${c + 1}`);
      } else {
        cells.push('🔒');
      }
    }

    const pointer =
      !revealAll && f === session.floor
        ? ` ◀ ЭТАЖ ${floorNum} (x${mult})`
        : f === 5
          ? ` 👑 (x${mult})`
          : ` (x${mult})`;
    lines.push(`${floorNum}┃ ${cells.join('  ')}${pointer}`);
  }
  return lines.join('\n');
}

function buildLadderKeyboard(session: LadderSession): InlineKeyboard {
  const mults = LADDER_MULTIPLIERS[session.mode];
  const kb: InlineKeyboard = [
    [
      { text: '🚪 Дверь 1', callbackData: `ldr:step:${session.id}:0` },
      { text: '🚪 Дверь 2', callbackData: `ldr:step:${session.id}:1` },
      { text: '🚪 Дверь 3', callbackData: `ldr:step:${session.id}:2` }
    ]
  ];
  if (session.floor >= 1) {
    const currentMult = mults[session.floor - 1];
    const potential = Math.round(session.stake * currentMult);
    kb.push([{ text: `💰 Забрать ${potential} 🪙 (x${currentMult})`, callbackData: `ldr:cash:${session.id}` }]);
  }
  return kb;
}

async function handleLadderCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];

  if (sub === 'cfg') {
    const mode: 'easy' | 'hard' = parts[2] === 'hard' ? 'hard' : 'easy';
    const stake = parseInt(parts[3], 10);
    const isLastDodep = parts[4] === '1';

    if (!Number.isFinite(stake) || stake <= 0 || player.balance < stake) {
      await transport.answerCallback(callbackId, 'Недостаточно фантиков!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `Призрак чата: жди ${formatDuration(ghostMs)}`, true);
      return;
    }

    deductPlayerStake(player, stake);
    scheduleSave();

    const floors: number[][] = [];
    for (let f = 0; f < 6; f++) {
      const row = mode === 'easy' ? [1, 1, 0] : [1, 0, 0];
      for (let i = row.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [row[i], row[j]] = [row[j], row[i]];
      }
      floors.push(row);
    }

    const sid = shortId();
    const session: LadderSession = {
      id: sid,
      chatId: chat.chatId,
      userId: player.userId,
      userName: displayName(player),
      stake,
      mode,
      isLastDodep,
      floor: 0,
      floors,
      pickedCols: [],
      status: 'playing',
      messageId: messageId || null,
      createdAt: Date.now()
    };
    ladderSessions.set(sid, session);

    const modeTitle = mode === 'hard' ? '🔴 Хардкор (1/3 дверь)' : '🟢 Лайт (2/3 двери)';
    const text = [
      `🪜 ЛЕСЕНКА ДОДЕПА · ${modeTitle}`,
      `👤 ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
      ``,
      renderLadderBoard(session),
      ``,
      `Выбирай дверь на 1-м этаже 👇`
    ].join('\n');
    const kb = buildLadderKeyboard(session);

    await transport.answerCallback(callbackId);
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, text, kb);
    } else {
      session.messageId = await transport.sendMessage(chat.chatId, text, kb);
    }
    return;
  }

  const sid = parts[2];
  const session = ladderSessions.get(sid);
  if (!session || session.status !== 'playing') {
    await transport.answerCallback(callbackId, 'Эта лесенка уже пройдена или сгорела.', true);
    return;
  }
  if (session.userId !== player.userId) {
    await transport.answerCallback(callbackId, 'Не лезь на чужую стремянку, кент!', true);
    return;
  }

  const mults = LADDER_MULTIPLIERS[session.mode];
  const modeTitle = session.mode === 'hard' ? '🔴 Хардкор' : '🟢 Лайт';

  if (sub === 'cash') {
    if (session.floor < 1) {
      await transport.answerCallback(callbackId, 'Пройди хотя бы 1-й этаж!', true);
      return;
    }
    session.status = 'finished';
    ladderSessions.delete(sid);

    const mult = mults[session.floor - 1];
    const payout = Math.round(session.stake * mult);
    const netProfit = payout - session.stake;

    player.balance += payout;
    player.lastBetAmount = session.stake;
    player.lastGameType = 'ladder';
    if (payout > session.stake) {
      player.stats.totalWon += netProfit;
      if (session.isLastDodep && player.lastActionWasLoss) {
        player.stats.lastDodepWins += 1;
      }
      player.lastActionWasLoss = false;
    } else {
      player.lastActionWasLoss = false;
    }
    player.lastActionWasLastDodep = false;
    if (session.floor >= 3) recordQuestProgress(player, 'skill_streak', 1);
    recordGameOutcome(chat, player, 'ladder', netProfit, { isLastDodep: session.isLastDodep });
    scheduleSave();

    await transport.answerCallback(callbackId, `Забрал ${payout} 🪙 (x${mult})!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: session.userName,
      event: `Лесенка: Кэшаут на ${session.floor}/6 этаже (x${mult})`,
      detail: `Ставка ${session.stake} → Выплата ${payout} 🪙`
    });

    const finalMsg = [
      `🪜 ЛЕСЕНКА ДОДЕПА — КЭШАУТ! (${modeTitle})`,
      `👤 ${playerLabel(chat, player)} | Этаж ${session.floor}/6`,
      ``,
      renderLadderBoard(session, true),
      ``,
      `🏆 Забрано: +${payout} 🪙 (x${mult}, чистыми +${netProfit})`,
      `🪙 Баланс: ${player.balance} фантиков`,
      ``,
      nextPhrase(chat, 'ladderStep')
    ].join('\n');

    await transport.editMessage(
      chat.chatId,
      session.messageId || messageId,
      finalMsg,
      buildPostGameKeyboard('ladder', session.stake, false, player)
    );
    if (netProfit > 0) {
      await applyAutoDebtCollection(transport, chat, player, netProfit);
    }
    return;
  }

  if (sub === 'step') {
    const col = parseInt(parts[3], 10);
    if (![0, 1, 2].includes(col)) {
      await transport.answerCallback(callbackId, 'Неверная дверь.', true);
      return;
    }

    const row = session.floors[session.floor];
    if (row[col] === 1) {
      session.pickedCols.push(col);
      session.floor += 1;

      // Reached the summit (floor 6/6) -> auto cashout!
      if (session.floor >= 6) {
        session.status = 'finished';
        ladderSessions.delete(sid);

        const mult = mults[5];
        const payout = Math.round(session.stake * mult);
        const netProfit = payout - session.stake;

        player.balance += payout;
        player.lastBetAmount = session.stake;
        player.lastGameType = 'ladder';
        player.stats.totalWon += Math.max(0, netProfit);
        if (session.isLastDodep && player.lastActionWasLoss) {
          player.stats.lastDodepWins += 1;
        }
        player.lastActionWasLoss = false;
        player.lastActionWasLastDodep = false;
        recordQuestProgress(player, 'skill_streak', 1);
        recordGameOutcome(chat, player, 'ladder', netProfit, { isLastDodep: session.isLastDodep });
        scheduleSave();

        await transport.answerCallback(callbackId, `👑 ВЕРШИНА 6/6! +${payout} 🪙 (x${mult})!`);
        addBotLog({
          source: transport.source,
          chatId: chat.chatId,
          chatTitle: chat.title,
          userName: session.userName,
          event: `Лесенка: ВЕРШИНА 6/6 (${modeTitle}, x${mult})`,
          detail: `Ставка ${session.stake} → Выплата ${payout} 🪙`
        });

        const topMsg = [
          `👑 ЛЕСЕНКА ДОДЕПА — ВЕРШИНА ПОКОРЕНА! (${modeTitle})`,
          `👤 ${playerLabel(chat, player)} | 6/6 этажей пройдено!`,
          ``,
          renderLadderBoard(session, true),
          ``,
          `🏆 МАКСИМАЛЬНЫЙ ЗАНОС: +${payout} 🪙 (x${mult}, чистыми +${netProfit})`,
          `🪙 Баланс: ${player.balance} фантиков`,
          ``,
          nextPhrase(chat, 'ladderStep')
        ].join('\n');

        await transport.editMessage(
          chat.chatId,
          session.messageId || messageId,
          topMsg,
          buildPostGameKeyboard('ladder', session.stake, false, player)
        );
        if (netProfit > 0) {
          await applyAutoDebtCollection(transport, chat, player, netProfit);
        }
        return;
      }

      const curMult = mults[session.floor - 1];
      const potential = Math.round(session.stake * curMult);
      await transport.answerCallback(callbackId, `✅ Прошёл этаж ${session.floor}/6! Банк: ${potential} 🪙 (x${curMult})`);

      const nextText = [
        `🪜 ЛЕСЕНКА ДОДЕПА · ${modeTitle}`,
        `👤 ${playerLabel(chat, player)} | Ставка: ${session.stake} 🪙`,
        `📈 Этаж ${session.floor}/6 пройден · Текущий банк: ${potential} 🪙 (x${curMult})`,
        ``,
        renderLadderBoard(session),
        ``,
        nextPhrase(chat, 'ladderStep')
      ].join('\n');

      await transport.editMessage(
        chat.chatId,
        session.messageId || messageId,
        nextText,
        buildLadderKeyboard(session)
      );
      return;
    }

    // Hit a trap!
    session.status = 'finished';
    ladderSessions.delete(sid);

    player.lastBetAmount = session.stake;
    player.lastGameType = 'ladder';
    player.stats.totalLost += session.stake;
    player.lastActionWasLoss = true;
    player.lastActionWasLastDodep = false;
    if (session.floor >= 3) recordQuestProgress(player, 'skill_streak', 1);
    recordGameOutcome(chat, player, 'ladder', -session.stake, { isLastDodep: session.isLastDodep });
    scheduleSave();

    await transport.answerCallback(callbackId, `💥 КАПКАН на ${session.floor + 1}-м этаже!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: session.userName,
      event: `Лесенка: Срыв на этаже ${session.floor + 1}/6`,
      detail: `Потеряно ${session.stake} 🪙 (${modeTitle})`
    });

    const bustMsg = [
      `💥 ЛЕСЕНКА ДОДЕПА — КАПКАН! (${modeTitle})`,
      `👤 ${playerLabel(chat, player)} сорвался на ${session.floor + 1}-м этаже!`,
      ``,
      renderLadderBoard(session, true, col),
      ``,
      `🥀 Сгорело: ${session.stake} фантиков`,
      `🪙 Баланс: ${player.balance} фантиков`,
      ``,
      nextPhrase(chat, 'ladderBust')
    ].join('\n');

    await transport.editMessage(
      chat.chatId,
      session.messageId || messageId,
      bustMsg,
      buildPostGameKeyboard('ladder', session.stake, true, player)
    );
    return;
  }

  await transport.answerCallback(callbackId);
}

// =======================
// COMMON TALISMAN POT ("ОБЩИЙ КОТЁЛ")
// =======================

function findActivePotForChat(chatId: string): TalismanPotLobby | null {
  for (const pot of potLobbies.values()) {
    if (pot.chatId === chatId && (pot.status === 'waiting' || pot.status === 'spinning')) {
      return pot;
    }
  }
  return null;
}

function refundPotEntries(chat: ChatState, entries: PotEntry[]): void {
  for (const e of entries) {
    const owner = chat.players[e.userId];
    if (owner) {
      syncTalismanPassiveIncome(owner);
      if (!owner.talismans) owner.talismans = [];
      owner.talismans.push({
        instanceId: e.instanceId,
        talismanId: e.talismanId,
        obtainedAt: Date.now()
      });
    }
    const def = TALISMAN_BY_ID[e.talismanId];
    if (def?.rarity === 'unique') {
      if (!chat.uniqueTalismans) chat.uniqueTalismans = {};
      chat.uniqueTalismans[e.talismanId] = {
        ownerId: e.userId,
        ownerName: owner ? displayName(owner) : e.firstName,
        obtainedAt: Date.now()
      };
    }
  }
}

function buildPotLobbyView(chat: ChatState, pot: TalismanPotLobby): { text: string; keyboard: InlineKeyboard } {
  const totalWeight = pot.entries.reduce((s, e) => s + e.weight, 0);
  const byUser = new Map<string, { name: string; weight: number; emojis: string[]; hasUnique: boolean }>();

  for (const e of pot.entries) {
    const def = TALISMAN_BY_ID[e.talismanId];
    const p = chat.players[e.userId];
    const name = p ? playerLabel(chat, p) : e.firstName;
    const cur = byUser.get(e.userId) || { name, weight: 0, emojis: [], hasUnique: false };
    cur.weight += e.weight;
    if (def) {
      cur.emojis.push(def.emoji);
      if (def.rarity === 'unique') cur.hasUnique = true;
    }
    byUser.set(e.userId, cur);
  }

  const lines: string[] = [
    `🍯 ОБЩИЙ КОТЁЛ ТАЛИСМАНОВ`,
    `📦 В котле: ${pot.entries.length} шт. · Общий вес: ${totalWeight} билетов`,
    `ℹ️ Вес = цене переработки (🔴 Уник = 8 500 билетов). Чем круче закинул — тем выше % забрать ВСЁ!`
  ];

  if (pot.countdownEndsAt && pot.status === 'waiting') {
    const leftMs = Math.max(0, pot.countdownEndsAt - Date.now());
    lines.push(`⏱ Авторозыгрыш через ~${Math.ceil(leftMs / 1000)} сек (или крути вручную!)`);
  }
  lines.push(``);

  if (byUser.size === 0) {
    lines.push(`Котёл пока пуст — закинь первый талисман из шкатулки!`);
  } else {
    lines.push(`👥 Участники и шансы:`);
    const sorted = [...byUser.values()].sort((a, b) => b.weight - a.weight);
    for (const u of sorted) {
      const pct = totalWeight > 0 ? ((u.weight / totalWeight) * 100).toFixed(1) : '0.0';
      const uniqMark = u.hasUnique ? ' 🔥[УНИК В БАНКЕ]' : '';
      lines.push(`• ${u.name}: ${pct}% (${u.weight} бил.) — ${u.emojis.join(' ')}${uniqMark}`);
    }
  }

  const distinctPlayers = byUser.size;
  const kb: InlineKeyboard = [
    [
      { text: '🎒 Выбрать талисман', callbackData: `pot:bag:${pot.id}:0` },
      { text: '🎲 Закинуть случайный', callbackData: `pot:addrand:${pot.id}` }
    ]
  ];

  if (distinctPlayers >= 2) {
    kb.push([{ text: '🔥 Крутить котёл сейчас!', callbackData: `pot:spin:${pot.id}` }]);
  }
  kb.push([
    { text: '🔄 Обновить', callbackData: `pot:refresh:${pot.id}` },
    { text: '❌ Отменить котёл', callbackData: `pot:cancel:${pot.id}` }
  ]);

  return { text: lines.join('\n'), keyboard: kb };
}

async function spinPotAndPayout(
  transport: BotTransport,
  chat: ChatState,
  pot: TalismanPotLobby
): Promise<void> {
  if (pot.status !== 'waiting') return;
  pot.status = 'spinning';
  if (pot.autoSpinTimer) {
    clearTimeout(pot.autoSpinTimer);
    pot.autoSpinTimer = null;
  }

  const distinctIds = new Set(pot.entries.map((e) => e.userId));
  if (distinctIds.size < 2 || pot.entries.length === 0) {
    refundPotEntries(chat, pot.entries);
    pot.status = 'finished';
    potLobbies.delete(pot.id);
    scheduleSave();
    if (pot.messageId) {
      await transport.editMessage(
        chat.chatId,
        pot.messageId,
        `🍯 Котёл талисманов закрыт: не набралось минимум 2 игрока. Все талисманы возвращены владельцам.`,
        [[{ text: '🍯 Открыть котёл', callbackData: 'pot:menu' }, { text: '🏠 В меню', callbackData: 'menu' }]]
      );
    }
    return;
  }

  const targetMsgId = pot.messageId;
  const totalWeight = pot.entries.reduce((s, e) => s + e.weight, 0);

  let acc = 0;
  const roll = Math.random() * totalWeight;
  let winningEntry = pot.entries[pot.entries.length - 1];
  for (const e of pot.entries) {
    acc += e.weight;
    if (roll <= acc) {
      winningEntry = e;
      break;
    }
  }

  const winner = chat.players[winningEntry.userId];
  const winnerName = winner ? playerLabel(chat, winner) : winningEntry.firstName;
  const participantNames = [...distinctIds].map((id) => {
    const p = chat.players[id];
    return p ? displayName(p) : 'Игрок';
  });

  if (targetMsgId) {
    const stepDelay = transport.source === 'telegram' ? 680 : 400;
    await transport.editMessage(
      chat.chatId,
      targetMsgId,
      [
        `🍯 КОТЁЛ ТАЛИСМАНОВ КРУТИТСЯ!`,
        `📦 На кону: ${pot.entries.length} шт. (${totalWeight} билетов)`,
        `👥 Участники: ${participantNames.join(', ')}`,
        ``,
        `🌀 Барабан мешает реликвии...`
      ].join('\n'),
      undefined,
      { isAnimation: true }
    );
    await sleep(stepDelay);

    await transport.editMessage(
      chat.chatId,
      targetMsgId,
      [
        `🍯 КОТЁЛ ТАЛИСМАНОВ — ОСТАНОВКА!`,
        `📦 Банк: ${pot.entries.length} шт. (${totalWeight} билетов)`,
        ``,
        `⚡ Стрелка замирает...`
      ].join('\n'),
      undefined,
      { isAnimation: true }
    );
    await sleep(stepDelay);
  }

  // Transfer all talismans & update unique registry ownership
  const wonEmojis: string[] = [];
  const stolenUniques: string[] = [];
  let winnerWeight = 0;

  if (winner) {
    syncTalismanPassiveIncome(winner);
    if (!winner.talismans) winner.talismans = [];
    for (const e of pot.entries) {
      if (e.userId === winner.userId) winnerWeight += e.weight;
      winner.talismans.push({
        instanceId: e.instanceId,
        talismanId: e.talismanId,
        obtainedAt: Date.now()
      });
      const def = TALISMAN_BY_ID[e.talismanId];
      if (def) {
        wonEmojis.push(def.emoji);
        if (def.rarity === 'unique') {
          if (!chat.uniqueTalismans) chat.uniqueTalismans = {};
          chat.uniqueTalismans[e.talismanId] = {
            ownerId: winner.userId,
            ownerName: displayName(winner),
            obtainedAt: Date.now()
          };
          if (e.userId !== winner.userId) {
            stolenUniques.push(`${def.emoji} ${def.name}`);
          }
        }
      }
    }
    winner.stats.gamesPlayed += 1;
  } else {
    refundPotEntries(chat, pot.entries);
  }

  pot.status = 'finished';
  potLobbies.delete(pot.id);
  scheduleSave();

  const winPct = totalWeight > 0 ? ((winnerWeight / totalWeight) * 100).toFixed(1) : '0.0';
  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: winner ? displayName(winner) : winningEntry.firstName,
    event: `Котёл талисманов (${pot.entries.length} шт.)`,
    detail: `Забрал банк ${totalWeight} бил. с шансом ${winPct}% (${wonEmojis.join(' ')})`
  });

  const finalLines = [
    `🏆 ОБЩИЙ КОТЁЛ — ПОБЕДИТЕЛЬ ОПРЕДЕЛЁН!`,
    ``,
    `🎉 ${winnerName} забирает ВСЁ с шансом ${winPct}%!`,
    `🎁 Добыча (${pot.entries.length} шт. · вес ${totalWeight} бил.): ${wonEmojis.join(' ')}`,
    ...(stolenUniques.length > 0
      ? [`🔴 ОТЖАТЫ УНИКАЛЬНЫЕ РЕЛИКВИИ: ${stolenUniques.join(', ')}!`]
      : []),
    ``,
    nextPhrase(chat, 'talismanPotWin')
  ];
  const kb: InlineKeyboard = [
    [
      { text: '🍯 Новый котёл', callbackData: 'pot:new' },
      { text: '🎒 Моя шкатулка', callbackData: 'tl:bag:0' }
    ],
    [{ text: '🏠 В меню', callbackData: 'menu' }]
  ];

  if (targetMsgId) {
    await transport.editMessage(chat.chatId, targetMsgId, finalLines.join('\n'), kb);
  } else {
    await transport.sendMessage(chat.chatId, finalLines.join('\n'), kb);
  }
}

async function tossTalismanIntoPot(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  pot: TalismanPotLobby,
  instanceId: string
): Promise<{ ok: boolean; error?: string; def?: TalismanDef; weight?: number }> {
  if (pot.status !== 'waiting') {
    return { ok: false, error: 'Котёл уже крутится или закрылся!' };
  }
  const list = player.talismans || [];
  const idx = list.findIndex((t) => t.instanceId === instanceId);
  if (idx === -1) {
    return { ok: false, error: 'Этот талисман уже в котле или не найден!' };
  }
  const item = list[idx];
  const def = TALISMAN_BY_ID[item.talismanId];
  if (!def) {
    return { ok: false, error: 'Неизвестный талисман.' };
  }

  syncTalismanPassiveIncome(player);
  list.splice(idx, 1);
  player.talismans = list;
  if (player.equippedTalismanId === def.id && !list.some((t) => t.talismanId === def.id)) {
    player.equippedTalismanId = null;
  }

  const weight = getTalismanPotWeight(def);
  pot.entries.push({
    instanceId: item.instanceId,
    talismanId: item.talismanId,
    userId: player.userId,
    firstName: displayName(player),
    weight
  });

  // Start 35s auto-spin countdown once at least 2 distinct players are inside
  const distinctPlayers = new Set(pot.entries.map((e) => e.userId));
  if (distinctPlayers.size >= 2 && !pot.countdownEndsAt) {
    pot.countdownEndsAt = Date.now() + 35_000;
    if (!isServerlessRuntime() && !pot.autoSpinTimer) {
      pot.autoSpinTimer = setTimeout(() => {
        void spinPotAndPayout(transport, chat, pot);
      }, 35_000);
    }
  }

  recordQuestProgress(player, 'social_pot_lot', 1);
  scheduleSave();
  markRuntimeDirty();
  return { ok: true, def, weight };
}

async function handlePotCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1] || 'menu';

  if (sub === 'menu') {
    const activePot = findActivePotForChat(chat.chatId);
    if (activePot && activePot.status === 'waiting') {
      await transport.answerCallback(callbackId);
      const view = buildPotLobbyView(chat, activePot);
      if (messageId) {
        await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
      } else {
        await transport.sendMessage(chat.chatId, view.text, view.keyboard);
      }
      return;
    }

    const col = getPlayerCollectionSummary(player);
    const introText = [
      `🍯 ОБЩИЙ КОТЁЛ ТАЛИСМАНОВ (ДЖЕКПОТ)`,
      `👤 ${playerLabel(chat, player)} | В шкатулке: ${col.count} шт.`,
      ``,
      `Правила пацанского котла:`,
      `• Игроки чата закидывают любые талисманы из шкатулки (даже 🔴 Уникальные!).`,
      `• Твой шанс забрать весь банк пропорционален ценности: цена переработки ♻️ (для 🔴 Уника — 8 500 билетов).`,
      `• Когда в котле 2+ игрока — 35 сек до розыгрыша или жми «Крутить сейчас!». Победитель забирает ВСЕ талисманы!`,
      ``,
      col.count === 0
        ? `⚠️ У тебя пока пустая шкатулка — сначала открой кейс в магазине!`
        : `Готов открыть котёл для всего чата?`
    ].join('\n');
    const kb: InlineKeyboard = [
      [{ text: '🔥 Открыть новый котёл', callbackData: 'pot:new' }],
      [
        { text: '🛒 Купить кейс', callbackData: 'tl:shop' },
        { text: '🏠 В меню', callbackData: 'menu' }
      ]
    ];

    await transport.answerCallback(callbackId);
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, introText, kb);
    } else {
      await transport.sendMessage(chat.chatId, introText, kb);
    }
    return;
  }

  if (sub === 'new') {
    const existing = findActivePotForChat(chat.chatId);
    if (existing) {
      await transport.answerCallback(callbackId, 'В чате уже открыт активный котёл!', true);
      const view = buildPotLobbyView(chat, existing);
      if (messageId) {
        await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
      } else {
        await transport.sendMessage(chat.chatId, view.text, view.keyboard);
      }
      return;
    }

    const pid = shortId();
    const pot: TalismanPotLobby = {
      id: pid,
      chatId: chat.chatId,
      creatorId: player.userId,
      entries: [],
      status: 'waiting',
      messageId: messageId || null,
      autoSpinTimer: null,
      countdownEndsAt: null,
      transportSource: transport.source,
      transport,
      createdAt: Date.now()
    };
    potLobbies.set(pid, pot);
    markRuntimeDirty();

    await transport.answerCallback(callbackId, 'Общий котёл открыт!');
    const view = buildPotLobbyView(chat, pot);
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    } else {
      pot.messageId = await transport.sendMessage(chat.chatId, view.text, view.keyboard);
    }
    return;
  }

  const potId = parts[2];
  const pot = potLobbies.get(potId);
  if (!pot || pot.status !== 'waiting') {
    await transport.answerCallback(callbackId, 'Этот котёл уже закрылся или завершился!', true);
    return;
  }

  if (sub === 'refresh') {
    if (pot.countdownEndsAt && Date.now() >= pot.countdownEndsAt) {
      await transport.answerCallback(callbackId, '⏱ Время вышло — крутим котёл!');
      await spinPotAndPayout(transport, chat, pot);
      return;
    }
    await transport.answerCallback(callbackId);
    const view = buildPotLobbyView(chat, pot);
    await transport.editMessage(chat.chatId, pot.messageId || messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'bag') {
    const pageRaw = parseInt(parts[3] || '0', 10) || 0;
    const grouped = groupPlayerTalismans(player);
    if (grouped.length === 0) {
      await transport.answerCallback(callbackId, 'Шкатулка пуста! Сначала открой кейс в магазине.', true);
      return;
    }

    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(grouped.length / pageSize));
    const page = Math.max(0, Math.min(pageRaw, totalPages - 1));
    const slice = grouped.slice(page * pageSize, (page + 1) * pageSize);

    const lines = [
      `🎒 ВЫБЕРИ ТАЛИСМАН В КОТЁЛ`,
      `👤 ${playerLabel(chat, player)} | Всего у тебя: ${(player.talismans || []).length} шт.`,
      ``
    ];
    const kb: InlineKeyboard = [];
    for (const g of slice) {
      const meta = RARITY_META[g.def.rarity];
      const weight = getTalismanPotWeight(g.def);
      const countMark = g.instances.length > 1 ? ` ×${g.instances.length}` : '';
      lines.push(`${meta.badge} ${g.def.emoji} ${g.def.name}${countMark} — ${weight} билетов`);
      kb.push([
        {
          text: `🍯 Закинуть ${g.def.emoji} ${g.def.name} (${weight} бил.)`,
          callbackData: `pot:toss:${pot.id}:${g.instances[0].instanceId}`
        }
      ]);
    }

    if (totalPages > 1) {
      const nav: InlineButton[] = [];
      if (page > 0) nav.push({ text: '⬅️ Назад', callbackData: `pot:bag:${pot.id}:${page - 1}` });
      nav.push({ text: `📄 ${page + 1}/${totalPages}`, callbackData: `pot:bag:${pot.id}:${page}` });
      if (page < totalPages - 1) nav.push({ text: 'Вперёд ➡️', callbackData: `pot:bag:${pot.id}:${page + 1}` });
      kb.push(nav);
    }
    kb.push([{ text: '↩️ К общему котлу', callbackData: 'pot:menu' }]);

    await transport.answerCallback(callbackId);
    // Keep shared pot card intact in group chat if clicked directly on pot.messageId
    if (pot.messageId && messageId === pot.messageId) {
      const bagMsgId = await transport.sendMessage(chat.chatId, lines.join('\n'), kb);
      setMessageOwner(chat.chatId, bagMsgId, player.userId);
    } else {
      await transport.editMessage(chat.chatId, messageId, lines.join('\n'), kb);
    }
    return;
  }

  if (sub === 'toss') {
    const instanceId = parts[3];
    const res = await tossTalismanIntoPot(transport, chat, player, pot, instanceId);
    if (!res.ok || !res.def) {
      await transport.answerCallback(callbackId, res.error || 'Ошибка ставки.', true);
      return;
    }

    await transport.answerCallback(
      callbackId,
      `🍯 Закинут ${res.def.emoji} ${res.def.name} (+${res.weight} билетов)!`
    );

    const view = buildPotLobbyView(chat, pot);
    if (pot.messageId) {
      await transport.editMessage(chat.chatId, pot.messageId, view.text, view.keyboard);
    }
    if (messageId && messageId !== pot.messageId) {
      await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    }
    return;
  }

  if (sub === 'addrand') {
    const list = player.talismans || [];
    if (list.length === 0) {
      await transport.answerCallback(callbackId, 'У тебя пустая шкатулка! Купи кейс сначала.', true);
      return;
    }
    // Prefer non-unique random talisman first; fall back to any (including unique) if user only holds uniques
    const nonUniques = list.filter((t) => TALISMAN_BY_ID[t.talismanId]?.rarity !== 'unique');
    const pool = nonUniques.length > 0 ? nonUniques : list;
    const picked = pool[Math.floor(Math.random() * pool.length)];

    const res = await tossTalismanIntoPot(transport, chat, player, pot, picked.instanceId);
    if (!res.ok || !res.def) {
      await transport.answerCallback(callbackId, res.error || 'Не вышло закинуть.', true);
      return;
    }

    await transport.answerCallback(
      callbackId,
      `🎲 Закинул ${res.def.emoji} ${res.def.name} (+${res.weight} билетов)!`
    );
    const view = buildPotLobbyView(chat, pot);
    if (pot.messageId) {
      await transport.editMessage(chat.chatId, pot.messageId, view.text, view.keyboard);
    }
    if (messageId && messageId !== pot.messageId) {
      await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    }
    return;
  }

  if (sub === 'spin') {
    const distinctIds = new Set(pot.entries.map((e) => e.userId));
    if (distinctIds.size < 2) {
      await transport.answerCallback(callbackId, 'Нужно минимум 2 разных игрока в котле!', true);
      return;
    }
    const isParticipant = pot.creatorId === player.userId || distinctIds.has(player.userId);
    if (!isParticipant) {
      await transport.answerCallback(callbackId, 'Крутить может создатель или участник котла!', true);
      return;
    }
    await transport.answerCallback(callbackId, '🔥 Крутим котёл!');
    await spinPotAndPayout(transport, chat, pot);
    return;
  }

  if (sub === 'cancel') {
    if (pot.creatorId !== player.userId) {
      await transport.answerCallback(callbackId, 'Отменить котёл может только его создатель!', true);
      return;
    }
    if (pot.autoSpinTimer) {
      clearTimeout(pot.autoSpinTimer);
      pot.autoSpinTimer = null;
    }
    refundPotEntries(chat, pot.entries);
    pot.status = 'finished';
    potLobbies.delete(pot.id);
    scheduleSave();

    await transport.answerCallback(callbackId, 'Котёл отменён, талисманы возвращены.');
    const targetId = pot.messageId || messageId;
    await transport.editMessage(
      chat.chatId,
      targetId,
      `❌ Общий котёл талисманов отменён создателем. Все ставки (${pot.entries.length} шт.) возвращены в шкатулки.`,
      [[{ text: '🍯 Новый котёл', callbackData: 'pot:new' }, { text: '🏠 В меню', callbackData: 'menu' }]]
    );
    return;
  }

  await transport.answerCallback(callbackId);
}

registerRuntimeAdapter('botEngine', {
  exportState: () => ({
    russianLobbies: Array.from(russianLobbies.values()).map(({ transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
    minesSessions: Array.from(minesSessions.values()).map(({ mines, opened, ...rest }) => ({
      ...rest,
      mines: Array.from(mines),
      opened: Array.from(opened)
    })),
    diceSessions: Array.from(diceSessions.values()),
    blackjackSessions: Array.from(blackjackSessions.values()),
    raceLobbies: Array.from(raceLobbies.values()).map(({ transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
    hiloSessions: Array.from(hiloSessions.values()),
    duelLobbies: Array.from(duelLobbies.values()).map(({ transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
    ladderSessions: Array.from(ladderSessions.values()),
    potLobbies: Array.from(potLobbies.values()).map(({ autoSpinTimer: _at, transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
    playerActiveGameGenre: Array.from(playerActiveGameGenre.entries()).slice(-500)
  }),
  importState: (raw: any) => {
    for (const p of potLobbies.values()) {
      if (p.autoSpinTimer) clearTimeout(p.autoSpinTimer);
    }
    russianLobbies.clear();
    minesSessions.clear();
    diceSessions.clear();
    blackjackSessions.clear();
    raceLobbies.clear();
    hiloSessions.clear();
    duelLobbies.clear();
    ladderSessions.clear();
    potLobbies.clear();
    playerActiveGameGenre.clear();

    if (Array.isArray(raw?.russianLobbies)) {
      for (const l of raw.russianLobbies) {
        if (l?.id && l.status !== 'finished') {
          russianLobbies.set(l.id, {
            ...l,
            players: Array.isArray(l.players) ? l.players : [],
            historyLines: Array.isArray(l.historyLines) ? l.historyLines : [],
            transport: null
          });
        }
      }
    }
    if (Array.isArray(raw?.minesSessions)) {
      for (const s of raw.minesSessions) {
        if (s?.id && s.status === 'playing') {
          minesSessions.set(s.id, {
            ...s,
            mines: new Set<number>(Array.isArray(s.mines) ? s.mines : []),
            opened: new Set<number>(Array.isArray(s.opened) ? s.opened : [])
          });
        }
      }
    }
    if (Array.isArray(raw?.diceSessions)) {
      for (const s of raw.diceSessions) {
        if (s?.id && s.status !== 'finished') diceSessions.set(s.id, s);
      }
    }
    if (Array.isArray(raw?.blackjackSessions)) {
      for (const s of raw.blackjackSessions) {
        if (s?.id && s.status === 'playing') {
          blackjackSessions.set(s.id, {
            ...s,
            deck: Array.isArray(s.deck) ? s.deck : [],
            playerHand: Array.isArray(s.playerHand) ? s.playerHand : [],
            dealerHand: Array.isArray(s.dealerHand) ? s.dealerHand : []
          });
        }
      }
    }
    if (Array.isArray(raw?.raceLobbies)) {
      for (const l of raw.raceLobbies) {
        if (l?.id && l.status !== 'finished') {
          raceLobbies.set(l.id, {
            ...l,
            bets: Array.isArray(l.bets) ? l.bets : [],
            positions: Array.isArray(l.positions) ? l.positions : [0, 0, 0, 0],
            transport: null
          });
        }
      }
    }
    if (Array.isArray(raw?.hiloSessions)) {
      for (const s of raw.hiloSessions) {
        if (s?.id && s.status === 'playing') {
          hiloSessions.set(s.id, {
            ...s,
            deck: Array.isArray(s.deck) ? s.deck : [],
            trail: Array.isArray(s.trail) ? s.trail : []
          });
        }
      }
    }
    if (Array.isArray(raw?.duelLobbies)) {
      for (const l of raw.duelLobbies) {
        if (l?.id && l.status !== 'finished') duelLobbies.set(l.id, { ...l, transport: null });
      }
    }
    if (Array.isArray(raw?.ladderSessions)) {
      for (const s of raw.ladderSessions) {
        if (s?.id && s.status === 'playing') {
          ladderSessions.set(s.id, {
            ...s,
            floors: Array.isArray(s.floors) ? s.floors : [],
            pickedCols: Array.isArray(s.pickedCols) ? s.pickedCols : []
          });
        }
      }
    }
    if (Array.isArray(raw?.potLobbies)) {
      for (const p of raw.potLobbies) {
        if (p?.id && p.status !== 'finished') {
          potLobbies.set(p.id, {
            ...p,
            entries: Array.isArray(p.entries) ? p.entries : [],
            autoSpinTimer: null,
            transport: null
          });
        }
      }
    }
    if (Array.isArray(raw?.playerActiveGameGenre)) {
      for (const [k, v] of raw.playerActiveGameGenre) {
        if (typeof k === 'string' && typeof v === 'string') {
          playerActiveGameGenre.set(k, v as GameGenre);
        }
      }
    }
  }
});



