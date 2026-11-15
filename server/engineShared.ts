import {
  ChatState,
  GameType,
  LoanRecord,
  OwnedTalisman,
  PlayerState,
  ZERO_BONUS_AMOUNT,
  ZERO_BONUS_COOLDOWN_MS,
  addBotLog,
  getZonedDateTimeParts,
  recordUsedPhraseKey,
  scheduleSave
} from './storage.js';
import { PhraseCategory, pickNonRepeatingPhrase } from './phrases.js';
import { TALISMAN_BY_ID } from './talismans.js';
import { markRuntimeDirty, registerRuntimeAdapter } from './runtimeRegistry.js';

export interface InlineButton {
  text: string;
  callbackData: string;
}

export type InlineKeyboard = InlineButton[][];

export interface BotTransport {
  source: 'telegram' | 'simulator';
  sendMessage(chatId: string, text: string, keyboard?: InlineKeyboard): Promise<string | null>;
  editMessage(
    chatId: string,
    messageId: string,
    text: string,
    keyboard?: InlineKeyboard,
    options?: { isAnimation?: boolean }
  ): Promise<void>;
  sendDice(chatId: string, emoji?: '🎲' | '🎰'): Promise<{ value: number; messageId: string | null }>;
  deleteMessage?(chatId: string, messageId: string): Promise<void>;
  answerCallback(callbackId: string, text?: string, showAlert?: boolean): Promise<void>;
  getRollDelayMs(): number;
}

export interface IncomingUser {
  userId: string;
  firstName: string;
  username?: string;
}

export interface IncomingChat {
  chatId: string;
  title?: string;
  type: ChatState['type'];
}

export const GAME_TITLES: Record<GameType, string> = {
  roulette: '🎡 Текстовая рулетка',
  crash: '🚀 Общий Краш чата (Мультиплеер)',
  russian: '🔫 Русская рулетка (2–3 игрока)',
  mines: '💣 Мины / Сапёр (5×5)',
  dice: '🎲 Кости против Дяди Депа (Догон)',
  blackjack: '🃏 Блэкджек (21) против Дяди Депа',
  plinko: '🔺 Плинко (Шарик по пирамиде)',
  races: '🪳 Тараканьи бега (Общий забег)',
  slots: '🎰 Однорукий Дядя (Слот 777)',
  hilo: '↕️ Больше / Меньше (Hi-Lo)',
  ladder: '🪜 Лесенка додепа (Башня 6 этажей)',
  duel: '🪙 Дуэль 1 на 1 (Орёл и Решка)',
  thimbles: '🥃 Напёрстки (3 стакана)',
  rps: '🪨✂️📄 Камень-Ножницы-Бумага',
  penalty: '⚽ Пенальти (Дуэль с вратарём)',
  dicepoker: '🎲 Покер на костях (5 кубиков)',
  bjtable: '🃏 Общий стол Блэкджека (2–4)'
};

export const GAME_RULES_SHORT: Record<GameType, string> = {
  roulette: 'Красное x2 · Чёрное x2 · Зеро x14. Шарик катится с комментариями.',
  crash: 'Общая ракета чата! Посадка 12 сек (или кнопка «Запустить сейчас!»). Успей нажать «Забрать», пока не бахнуло!',
  russian: 'Барабан на 6 слотов, 1 патрон. Проигравший становится Призраком на 3 мин, выжившие делят банк!',
  mines: 'Сетка 5×5 с 3, 5 или 7 минами. Чем больше чистых клеток — тем жирнее икс.',
  dice: 'Бросаем кубики против бота. Больше — забираешь x2. Проиграл — жми Ласт додеп (x2)!',
  blackjack: 'Набери ближе к 21, чем Дядя Деп, без перебора. Победа x2, Блэкджек с раздачи x2.5, ничья — возврат!',
  plinko: 'Выбирай уровень риска (Низкий до x2.4, Средний до x4.5, Высокий до x12) и кидай шарик через 6 рядов штырьков!',
  races: 'У каждого таракана свой шанс и честный икс: 🪳 Виталя x2.2, 🐀 Крысюк x3.2, 🦀 Олигарх x5.0, 🐌 Тормоз x12. Можно бежать соло или всем чатом!',
  slots: 'Нативный слот 🎰 Telegram! 777 дают x20, три в ряд — x7.5, две 7️⃣ — x1.5, две подряд — x0.5.',
  hilo: 'Угадай, будет следующая карта выше или ниже! С каждой верной картой растёт икс, ничья — пронесло.',
  ladder: 'Поднимайся по 6 этажам башни: выбирай 1 из 3 дверей! Лайт (до x10.94) или Хардкор (до x699.84).',
  duel: 'Быстрый PvP-вызов ровно 1 на 1 на ставку! Выбери Орла или Решку — кто примет вызов, с тем и делите банк x2!',
  thimbles: 'Следи за золотым шариком под тремя стаканами после перемешивания! Угадал стакан — забираешь x2.85.',
  rps: 'Классика двора: сыграй сразу против Дяди Депа или открой PvP-вызов 1×1 для чата. Победа — x2!',
  penalty: 'Серия из 5 ударов по 3 зонам ворот: каждый гол поднимает икс (x1.44 → x2.16 → x3.24 → x4.86 → x7.29). Забирай в любой момент!',
  dicepoker: '5 кубиков + 1 переброс выбранных костей! От пары (x0.5) и двух пар (x1.2) до Каре (x12) и Покера (x30).',
  bjtable: 'Общий стол на 2–4 игроков против Дяди Депа! Победа x2, натуральные 21 с раздачи x2.5, ничья — возврат.'
};

export function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

const MAX_OWNED_MESSAGE_KEYS = 5000;
const messageOwnerByKey = new Map<string, string>();
const playerActiveMenuMsgId = new Map<string, string>();

registerRuntimeAdapter('engineShared', {
  exportState: () => ({
    messageOwnerByKey: Array.from(messageOwnerByKey.entries()).slice(-400),
    playerActiveMenuMsgId: Array.from(playerActiveMenuMsgId.entries()).slice(-200)
  }),
  importState: (raw: any) => {
    messageOwnerByKey.clear();
    playerActiveMenuMsgId.clear();
    if (Array.isArray(raw?.messageOwnerByKey)) {
      for (const [k, v] of raw.messageOwnerByKey) {
        if (typeof k === 'string' && typeof v === 'string') messageOwnerByKey.set(k, v);
      }
    }
    if (Array.isArray(raw?.playerActiveMenuMsgId)) {
      for (const [k, v] of raw.playerActiveMenuMsgId) {
        if (typeof k === 'string' && typeof v === 'string') playerActiveMenuMsgId.set(k, v);
      }
    }
  }
});

export function setMessageOwner(
  chatId: string,
  messageId: string | null | undefined,
  userId: string
): void {
  if (!messageId || !userId) return;
  const key = `${chatId}:${messageId}`;
  if (!messageOwnerByKey.has(key) && messageOwnerByKey.size >= MAX_OWNED_MESSAGE_KEYS) {
    const oldestKey = messageOwnerByKey.keys().next().value;
    if (oldestKey !== undefined) messageOwnerByKey.delete(oldestKey);
  }
  messageOwnerByKey.set(key, userId);
  markRuntimeDirty();
}

export function getMessageOwner(
  chatId: string,
  messageId: string | null | undefined
): string | null {
  if (!messageId) return null;
  return messageOwnerByKey.get(`${chatId}:${messageId}`) || null;
}

export function setPlayerActiveMenuMsgId(
  chatId: string,
  userId: string,
  messageId: string
): void {
  if (!messageId || !userId) return;
  const key = `${chatId}:${userId}`;
  if (!playerActiveMenuMsgId.has(key) && playerActiveMenuMsgId.size >= MAX_OWNED_MESSAGE_KEYS) {
    const oldestKey = playerActiveMenuMsgId.keys().next().value;
    if (oldestKey !== undefined) playerActiveMenuMsgId.delete(oldestKey);
  }
  playerActiveMenuMsgId.set(key, messageId);
  markRuntimeDirty();
}

export function getPlayerActiveMenuMsgId(
  chatId: string,
  userId: string
): string | undefined {
  return playerActiveMenuMsgId.get(`${chatId}:${userId}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function displayName(player: { firstName: string; username?: string }): string {
  return player.firstName || (player.username ? `@${player.username}` : 'Игрок');
}

export function getRemainingDebt(loan: LoanRecord): number {
  return Math.max(0, loan.repayAmount - loan.paidAmount);
}

export function getActiveLoansForBorrower(chat: ChatState, userId: string): LoanRecord[] {
  return (chat.loans || []).filter((l) => l.borrowerId === userId && l.status === 'active' && getRemainingDebt(l) > 0);
}

export function getActiveLoansForLender(chat: ChatState, userId: string): LoanRecord[] {
  return (chat.loans || []).filter((l) => l.lenderId === userId && l.status === 'active' && getRemainingDebt(l) > 0);
}

export function getTotalRemainingDebt(chat: ChatState, userId: string): number {
  return getActiveLoansForBorrower(chat, userId).reduce((sum, l) => sum + getRemainingDebt(l), 0);
}

export function isLoanOverdue(loan: LoanRecord, now = Date.now()): boolean {
  return loan.status === 'active' && getRemainingDebt(loan) > 0 && now >= loan.dueAt;
}

export function hasOverdueDebt(chat: ChatState, userId: string, now = Date.now()): boolean {
  return getActiveLoansForBorrower(chat, userId).some((l) => isLoanOverdue(l, now));
}

export function getEquippedTalismanEmoji(player: {
  equippedTalismanId?: string | null;
  talismans?: OwnedTalisman[];
}): string | null {
  const eqId = player.equippedTalismanId;
  if (!eqId) return null;
  const def = TALISMAN_BY_ID[eqId];
  if (!def) return null;
  if (player.talismans && !player.talismans.some((t) => t.talismanId === eqId)) {
    return null;
  }
  return def.emoji;
}

export function playerLabel(
  chat: ChatState,
  player: {
    userId?: string;
    firstName: string;
    username?: string;
    equippedTalismanId?: string | null;
    talismans?: OwnedTalisman[];
  }
): string {
  const base = displayName(player);
  const badge = getEquippedTalismanEmoji(player);
  const withBadge = badge ? `${badge} ${base}` : base;
  if (player.userId && hasOverdueDebt(chat, player.userId)) {
    return `${withBadge} 💸[ДОЛЖНИК]`;
  }
  return withBadge;
}

export function getGhostRemainingMs(player: PlayerState): number {
  const diff = player.ghostUntil - Date.now();
  return diff > 0 ? diff : 0;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours} ч ${mins} мин ${secs} сек`;
  if (mins > 0) return `${mins} мин ${secs} сек`;
  return `${secs} сек`;
}

export function nextPhrase(chat: ChatState, category: PhraseCategory): string {
  const { text, key } = pickNonRepeatingPhrase(category, chat.usedPhraseKeys || []);
  recordUsedPhraseKey(chat, key);
  return text;
}

export function deductPlayerStake(player: PlayerState, stake: number): boolean {
  const isAllIn = stake > 0 && stake >= player.balance;
  if (isAllIn) {
    player.stats.allInCount = (player.stats.allInCount || 0) + 1;
  }
  player.balance -= stake;
  player.stats.gamesPlayed += 1;
  return isAllIn;
}

export function buildPostGameKeyboard(
  game: GameType,
  betAmount: number,
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

  const doubleBet = Math.max(50, betAmount * 2);
  if (wasLoss) {
    return [
      [{ text: `🔥 Ласт додеп (x2: ${doubleBet})`, callbackData: `ld:${game}:${doubleBet}` }],
      [
        { text: `🔁 Повторить (${betAmount})`, callbackData: `rep:${game}:${betAmount}` },
        { text: '🏠 В меню', callbackData: 'menu' }
      ]
    ];
  }
  return [
    [
      { text: `🔁 Повторить (${betAmount})`, callbackData: `rep:${game}:${betAmount}` },
      { text: `⚡ Ласт додеп (x2: ${doubleBet})`, callbackData: `ld:${game}:${doubleBet}` }
    ],
    [{ text: '🏠 В меню', callbackData: 'menu' }]
  ];
}

export async function sendZeroBalanceOffer(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  existingMsgId?: string | null
): Promise<void> {
  const offerText = [
    `🧔‍♂️ Дядя Деп глянул в пустой карман (${playerLabel(chat, player)}):`,
    ``,
    nextPhrase(chat, 'bonusOffer')
  ].join('\n');
  const kb: InlineKeyboard = [
    [{ text: `🤲 Взять ${ZERO_BONUS_AMOUNT} фантиков`, callbackData: 'bonus_take' }],
    [{ text: '🙏 Попросить в долг в чате', callbackData: 'ln:ask' }],
    [{ text: '🏠 В меню', callbackData: 'menu' }]
  ];

  if (existingMsgId) {
    await transport.editMessage(chat.chatId, existingMsgId, offerText, kb);
  } else {
    const sentId = await transport.sendMessage(chat.chatId, offerText, kb);
    setMessageOwner(chat.chatId, sentId, player.userId);
  }
}

export async function maybeSendZeroBalanceOffer(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState
): Promise<void> {
  if (player.balance > 0) return;
  const elapsed = Date.now() - player.lastZeroBonusAt;
  if (player.lastZeroBonusAt > 0 && elapsed < ZERO_BONUS_COOLDOWN_MS) {
    return;
  }
  await sendZeroBalanceOffer(transport, chat, player);
}

export async function applyAutoDebtCollection(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  netProfit: number
): Promise<void> {
  if (netProfit <= 0 || player.balance <= 0) return;
  const activeLoans = getActiveLoansForBorrower(chat, player.userId);
  if (activeLoans.length === 0) return;

  const now = Date.now();
  const hasOverdue = activeLoans.some((l) => isLoanOverdue(l, now));
  let budget = hasOverdue
    ? Math.min(netProfit, player.balance)
    : Math.min(Math.max(1, Math.round(netProfit * 0.5)), player.balance);
  if (budget <= 0) return;

  const sortedLoans = [...activeLoans].sort((a, b) => {
    const aOver = isLoanOverdue(a, now) ? 0 : 1;
    const bOver = isLoanOverdue(b, now) ? 0 : 1;
    if (aOver !== bOver) return aOver - bOver;
    return a.createdAt - b.createdAt;
  });

  const collectedLines: string[] = [];
  let totalCollected = 0;

  for (const loan of sortedLoans) {
    if (budget <= 0) break;
    const remaining = getRemainingDebt(loan);
    if (remaining <= 0) continue;

    const take = Math.min(remaining, budget, player.balance);
    if (take <= 0) continue;

    player.balance -= take;
    budget -= take;
    totalCollected += take;
    loan.paidAmount += take;

    const lender = chat.players[loan.lenderId];
    if (lender) {
      lender.balance += take;
    }

    const leftAfter = getRemainingDebt(loan);
    if (leftAfter === 0) {
      loan.status = 'repaid';
    }

    const statusStr = leftAfter === 0 ? 'долг полностью закрыт ✅' : `осталось ${leftAfter} 🪙`;
    collectedLines.push(`• Кенту ${loan.lenderName} ушло ${take} 🪙 (${statusStr})`);
  }

  if (totalCollected <= 0) return;
  scheduleSave();

  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: 'Коллектор Дядя Деп',
    detail: `Списано ${totalCollected} 🪙 с выигрыша в счёт P2P долгов`
  });

  await transport.sendMessage(
    chat.chatId,
    [
      `💼 КОЛЛЕКТОР ДЯДЯ ДЕП НА СВЯЗИ!`,
      `👤 С выигрыша ${playerLabel(chat, player)} автоматически списано ${totalCollected} 🪙:`,
      ...collectedLines,
      `🪙 Баланс после расчёта: ${player.balance} фантиков`,
      ``,
      nextPhrase(chat, 'loanCollected')
    ].join('\n'),
    [
      [
        { text: '🤝 Долги и займы', callbackData: 'ln:menu' },
        { text: '🏠 В меню', callbackData: 'menu' }
      ]
    ]
  );
}

export function getTodayDateStr(): string {
  return getZonedDateTimeParts().dateStr;
}
