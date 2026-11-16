import {
  BotTransport,
  InlineKeyboard,
  applyAutoDebtCollection,
  deductPlayerStake,
  displayName,
  formatDuration,
  getGhostRemainingMs,
  maybeSendZeroBalanceOffer,
  nextPhrase,
  playerLabel,
  refundPlayerStake,
  shortId
} from '../engineShared.js';
import {
  ChatState,
  LOBBY_IDLE_TTL_MS,
  PlayerState,
  addBotLog,
  getDb,
  scheduleSave
} from '../storage.js';
import { recordGameOutcome } from '../features/profileQuests.js';
import {
  markRuntimeDirty,
  registerRuntimeAdapter,
  resolveRuntimeTransport
} from '../runtimeRegistry.js';

interface BjCard {
  rank: string;
  suit: string;
  value: number;
}

interface MultiBjSeat {
  userId: string;
  firstName: string;
  stake: number;
  initialStake: number;
  isLastDodep: boolean;
  isAllIn?: boolean;
  hand: BjCard[];
  doubled: boolean;
  status: 'playing' | 'stood' | 'bust' | 'blackjack';
}

interface MultiBjTable {
  id: string;
  chatId: string;
  baseStake: number;
  creatorId: string;
  status: 'waiting' | 'playing' | 'finished';
  deck: BjCard[];
  dealerHand: BjCard[];
  seats: MultiBjSeat[];
  turnIndex: number;
  messageId: string | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
  lastActionAt: number;
}

const bjTables = new Map<string, MultiBjTable>();

function getTableTransport(table: MultiBjTable): BotTransport | null {
  return resolveRuntimeTransport(table.transportSource, table.chatId, table.transport);
}

registerRuntimeAdapter('multiBlackjack', {
  exportState: () =>
    Array.from(bjTables.values()).map(({ transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
  importState: (raw: any) => {
    bjTables.clear();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item?.id || item.status === 'finished') continue;
        bjTables.set(item.id, {
          ...item,
          deck: Array.isArray(item.deck) ? item.deck : [],
          dealerHand: Array.isArray(item.dealerHand) ? item.dealerHand : [],
          seats: Array.isArray(item.seats)
            ? item.seats.map((s: any) => ({ ...s, hand: Array.isArray(s?.hand) ? s.hand : [] }))
            : [],
          transport: null
        });
      }
    }
  }
});

function createShuffledDeck(): BjCard[] {
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
  const deck: BjCard[] = [];
  for (const suit of suits) {
    for (const r of ranks) deck.push({ rank: r.rank, suit, value: r.value });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calcScore(cards: BjCard[]): number {
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

function formatHand(cards: BjCard[]): string {
  return cards.map((c) => `[${c.rank}${c.suit}]`).join(' ');
}

export function isMultiBlackjackProtectedMsg(msgId: string): boolean {
  for (const t of bjTables.values()) {
    if (t.status !== 'finished' && t.messageId === msgId) return true;
  }
  return false;
}

export async function sweepExpiredMultiBlackjack(now = Date.now()): Promise<void> {
  const db = getDb();
  for (const [tid, table] of Array.from(bjTables.entries())) {
    const waitingExpired = table.status === 'waiting' && now - table.createdAt >= LOBBY_IDLE_TTL_MS;
    const playingExpired = table.status === 'playing' && now - table.lastActionAt >= 10 * 60 * 1000;
    if (!waitingExpired && !playingExpired) continue;

    bjTables.delete(tid);
    table.status = 'finished';
    markRuntimeDirty();
    const chat = db.chats[table.chatId];
    for (const seat of table.seats) {
      const p = chat?.players[seat.userId];
      if (p) refundPlayerStake(p, seat.stake, seat.isAllIn);
    }
    scheduleSave();

    addBotLog({
      source: 'scheduler',
      chatId: table.chatId,
      chatTitle: chat?.title || table.chatId,
      event: 'Таймаут стола 21 (2–4)',
      detail: `Возвращены ставки (${table.seats.length} игроков)`
    });

    const tr = getTableTransport(table);
    if (table.messageId && tr) {
      await tr.editMessage(
        table.chatId,
        table.messageId,
        `⏱ Общий стол Блэкджека закрыт по таймауту. Все ставки возвращены игрокам.`,
        [[{ text: '🏠 В меню', callbackData: 'menu' }]]
      );
    }
  }
}

function buildLobbyView(chat: ChatState, table: MultiBjTable): { text: string; keyboard: InlineKeyboard } {
  const seatLines = table.seats.map((s, idx) => {
    const p = chat.players[s.userId];
    const name = p ? playerLabel(chat, p) : s.firstName;
    return `${idx + 1}. 💺 ${name} — ${s.stake} 🪙`;
  });

  const lines = [
    `🃏 ОБЩИЙ СТОЛ БЛЭКДЖЕКА (2–4 ИГРОКА)`,
    `💰 Входная ставка за бокс: ${table.baseStake} 🪙`,
    `👥 Места за столом (${table.seats.length}/4):`,
    ...seatLines,
    ``,
    table.seats.length < 2
      ? `Ждём ещё хотя бы 1 игрока из чата (максимум 4)!`
      : `Можно запускать раздачу или дождаться ещё пацанов (до 4 мест).`
  ];

  const kb: InlineKeyboard = [
    [{ text: `💺 Сесть за стол (${table.baseStake} 🪙)`, callbackData: `bjt:join:${table.id}` }]
  ];
  if (table.seats.length >= 2) {
    kb.push([{ text: `▶️ Начать раздачу (${table.seats.length}/4)`, callbackData: `bjt:go:${table.id}` }]);
  }
  kb.push([{ text: '❌ Отменить стол (создатель)', callbackData: `bjt:stop:${table.id}` }]);

  return { text: lines.join('\n'), keyboard: kb };
}

function buildPlayingView(chat: ChatState, table: MultiBjTable): { text: string; keyboard: InlineKeyboard } {
  const dealerVisible = table.dealerHand[0];
  const dealerVal = dealerVisible.rank === 'A' ? 11 : dealerVisible.value;
  const activeSeat = table.seats[table.turnIndex];

  const seatLines = table.seats.map((s, idx) => {
    const p = chat.players[s.userId];
    const name = p ? playerLabel(chat, p) : s.firstName;
    const score = calcScore(s.hand);
    const pointer = idx === table.turnIndex ? '👉 ' : '';
    const statusTag =
      s.status === 'blackjack'
        ? '⚡ БЛЭКДЖЕК!'
        : s.status === 'bust'
          ? '💥 Перебор'
          : s.status === 'stood'
            ? s.doubled
              ? '✋ Удвоил'
              : '✋ Стоит'
            : '⏳ Ходит';
    return `${pointer}${idx + 1}. ${name} (${s.stake} 🪙): ${formatHand(s.hand)} = ${score} · ${statusTag}`;
  });

  const activePlayerObj = chat.players[activeSeat.userId];
  const activeLabel = activePlayerObj ? playerLabel(chat, activePlayerObj) : activeSeat.firstName;

  const lines = [
    `🃏 ОБЩИЙ СТОЛ БЛЭКДЖЕКА — ИГРА`,
    `🧔‍♂️ Дилер Дядя Деп (${dealerVal}+?): [${dealerVisible.rank}${dealerVisible.suit}] 🂠`,
    ``,
    ...seatLines,
    ``,
    `🎯 Сейчас ходит: ${activeLabel}`
  ];

  const row1 = [
    { text: '🃏 Ещё карту', callbackData: `bjt:hit:${table.id}` },
    { text: '✋ Хватит', callbackData: `bjt:stand:${table.id}` }
  ];
  const kb: InlineKeyboard = [row1];
  if (
    activeSeat.hand.length === 2 &&
    activePlayerObj &&
    activePlayerObj.balance >= activeSeat.stake
  ) {
    kb.push([{ text: `⚡ Удвоить (+${activeSeat.stake} 🪙)`, callbackData: `bjt:dbl:${table.id}` }]);
  }

  return { text: lines.join('\n'), keyboard: kb };
}

async function renderLobby(chat: ChatState, table: MultiBjTable): Promise<void> {
  const view = buildLobbyView(chat, table);
  const tr = getTableTransport(table);
  if (!tr) return;
  if (table.messageId) {
    await tr.editMessage(chat.chatId, table.messageId, view.text, view.keyboard);
  } else {
    table.messageId = await tr.sendMessage(chat.chatId, view.text, view.keyboard);
  }
}

async function renderPlaying(chat: ChatState, table: MultiBjTable): Promise<void> {
  const view = buildPlayingView(chat, table);
  const tr = getTableTransport(table);
  if (!tr) return;
  if (table.messageId) {
    await tr.editMessage(chat.chatId, table.messageId, view.text, view.keyboard);
  } else {
    table.messageId = await tr.sendMessage(chat.chatId, view.text, view.keyboard);
  }
}

async function startMultiBlackjackRound(chat: ChatState, table: MultiBjTable): Promise<void> {
  table.status = 'playing';
  table.lastActionAt = Date.now();
  table.deck = createShuffledDeck();
  table.dealerHand = [table.deck.pop()!, table.deck.pop()!];

  for (const seat of table.seats) {
    seat.hand = [table.deck.pop()!, table.deck.pop()!];
    if (calcScore(seat.hand) === 21) {
      seat.status = 'blackjack';
    } else {
      seat.status = 'playing';
    }
  }

  const nextIdx = table.seats.findIndex((s) => s.status === 'playing');
  if (nextIdx === -1) {
    await finishMultiBlackjackRound(chat, table);
    return;
  }

  table.turnIndex = nextIdx;
  await renderPlaying(chat, table);
}

async function advanceTurnOrFinish(chat: ChatState, table: MultiBjTable): Promise<void> {
  const nextIdx = table.seats.findIndex((s) => s.status === 'playing');
  if (nextIdx === -1) {
    await finishMultiBlackjackRound(chat, table);
    return;
  }
  table.turnIndex = nextIdx;
  await renderPlaying(chat, table);
}

async function finishMultiBlackjackRound(chat: ChatState, table: MultiBjTable): Promise<void> {
  table.status = 'finished';
  bjTables.delete(table.id);
  markRuntimeDirty();

  // Dealer draws to 17 if at least one seat stood (not busted & not everyone natural BJ)
  const needsDealerDraw = table.seats.some((s) => s.status === 'stood');
  if (needsDealerDraw) {
    while (calcScore(table.dealerHand) < 17) {
      const card = table.deck.pop();
      if (!card) break;
      table.dealerHand.push(card);
    }
  }

  const dScore = calcScore(table.dealerHand);
  const dealerNat21 = table.dealerHand.length === 2 && dScore === 21;

  const resultLines: string[] = [];
  const winnersToCollect: { player: PlayerState; net: number }[] = [];
  const zeroPlayers: PlayerState[] = [];

  for (const seat of table.seats) {
    const p = chat.players[seat.userId];
    const pScore = calcScore(seat.hand);
    const label = p ? playerLabel(chat, p) : seat.firstName;

    let payout = 0;
    let verdict = '';
    let wasLoss = false;

    if (seat.status === 'bust') {
      payout = 0;
      wasLoss = true;
      verdict = `💥 Перебор (${pScore}) · -${seat.stake} 🪙`;
    } else if (seat.status === 'blackjack' && !dealerNat21) {
      payout = Math.round(seat.stake * 2.5);
      verdict = `⚡ БЛЭКДЖЕК x2.5 · +${payout} 🪙`;
    } else if (seat.status === 'blackjack' && dealerNat21) {
      payout = seat.stake;
      verdict = `🤝 Ничья (21 vs 21) · возврат ${payout} 🪙`;
    } else if (dealerNat21) {
      payout = 0;
      wasLoss = true;
      verdict = `💀 У дилера 21 · -${seat.stake} 🪙`;
    } else if (dScore > 21 || pScore > dScore) {
      payout = seat.stake * 2;
      verdict = `🏆 Победа (${pScore}) · +${payout} 🪙`;
    } else if (pScore === dScore) {
      payout = seat.stake;
      verdict = `🤝 Ничья (${pScore}) · возврат ${payout} 🪙`;
    } else {
      payout = 0;
      wasLoss = true;
      verdict = `💀 Проигрыш (${pScore}) · -${seat.stake} 🪙`;
    }

    if (p) {
      p.lastBetAmount = seat.initialStake;
      p.lastGameType = 'bjtable';
      const net = payout - seat.stake;

      if (payout > seat.stake) {
        p.balance += payout;
        p.stats.totalWon += net;
        if (seat.isLastDodep && p.lastActionWasLoss) {
          p.stats.lastDodepWins += 1;
        }
        p.lastActionWasLoss = false;
        p.lastActionWasLastDodep = false;
        winnersToCollect.push({ player: p, net });
      } else if (payout === seat.stake) {
        p.balance += payout;
        p.lastActionWasLoss = false;
        p.lastActionWasLastDodep = false;
      } else {
        p.stats.totalLost += seat.stake;
        p.lastActionWasLoss = true;
        p.lastActionWasLastDodep = false;
        if (p.balance <= 0) zeroPlayers.push(p);
      }

      recordGameOutcome(chat, p, 'bjtable', net, { isLastDodep: seat.isLastDodep });
    }

    resultLines.push(
      `• ${label}: ${formatHand(seat.hand)} = ${pScore}\n  ${verdict}`
    );
  }

  scheduleSave();

  const anyWon = winnersToCollect.length > 0;
  const comment = anyWon ? nextPhrase(chat, 'blackjackWin') : nextPhrase(chat, 'blackjackLoss');

  const tr = getTableTransport(table);
  addBotLog({
    source: tr?.source || 'telegram',
    chatId: chat.chatId,
    chatTitle: chat.title,
    event: `Стол 21 (${table.seats.length} игр.)`,
    detail: `Дилер набрал ${dScore}. Победителей: ${winnersToCollect.length}/${table.seats.length}`
  });

  const text = [
    `🃏 ИТОГИ ОБЩЕГО СТОЛА БЛЭКДЖЕКА`,
    `🧔‍♂️ Дядя Деп (${dScore}): ${formatHand(table.dealerHand)}${dScore > 21 ? ' 💥 ПЕРЕБОР!' : ''}`,
    ``,
    ...resultLines,
    ``,
    comment
  ].join('\n');

  const kb: InlineKeyboard = [
    [
      { text: '🃏 Новый стол 21 (2–4)', callbackData: 'g:bjtable' },
      { text: '🏠 В меню', callbackData: 'menu' }
    ]
  ];

  if (tr) {
    if (table.messageId) {
      await tr.editMessage(chat.chatId, table.messageId, text, kb);
    } else {
      await tr.sendMessage(chat.chatId, text, kb);
    }

    for (const w of winnersToCollect) {
      await applyAutoDebtCollection(tr, chat, w.player, w.net);
    }
    for (const zp of zeroPlayers) {
      await maybeSendZeroBalanceOffer(tr, chat, zp);
    }
  }
}

export async function startMultiBlackjackLobby(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  stake: number,
  isLastDodep: boolean,
  messageId?: string
): Promise<void> {
  const isAllIn = deductPlayerStake(player, stake);
  scheduleSave();

  const now = Date.now();
  const table: MultiBjTable = {
    id: shortId(),
    chatId: chat.chatId,
    baseStake: stake,
    creatorId: player.userId,
    status: 'waiting',
    deck: [],
    dealerHand: [],
    seats: [
      {
        userId: player.userId,
        firstName: displayName(player),
        stake,
        initialStake: stake,
        isLastDodep,
        isAllIn,
        hand: [],
        doubled: false,
        status: 'playing'
      }
    ],
    turnIndex: 0,
    messageId: messageId || null,
    transportSource: transport.source,
    transport,
    createdAt: now,
    lastActionAt: now
  };
  bjTables.set(table.id, table);
  markRuntimeDirty();

  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: `Открыт стол 21 (${stake} 🪙)`,
    detail: `Ожидание 2–4 игроков`
  });

  await renderLobby(chat, table);
}

export async function handleMultiBlackjackCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  _messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];
  const tableId = parts[2];
  const table = bjTables.get(tableId);

  if (!table) {
    await transport.answerCallback(callbackId, 'Этот стол уже закрыт или завершён.', true);
    return;
  }

  if (sub === 'join') {
    if (table.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Раздача за столом уже началась!', true);
      return;
    }
    if (table.seats.some((s) => s.userId === player.userId)) {
      await transport.answerCallback(callbackId, 'Ты уже сидишь за этим столом!', true);
      return;
    }
    if (table.seats.length >= 4) {
      await transport.answerCallback(callbackId, 'Все 4 бокса уже заняты!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Ты Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    if (player.balance < table.baseStake) {
      await transport.answerCallback(
        callbackId,
        `Нужно ${table.baseStake} 🪙 для входа за стол, у тебя ${player.balance} 🪙.`,
        true
      );
      return;
    }

    const isAllIn = deductPlayerStake(player, table.baseStake);
    table.seats.push({
      userId: player.userId,
      firstName: displayName(player),
      stake: table.baseStake,
      initialStake: table.baseStake,
      isLastDodep: false,
      isAllIn,
      hand: [],
      doubled: false,
      status: 'playing'
    });
    table.lastActionAt = Date.now();
    scheduleSave();

    if (table.seats.length >= 4) {
      await transport.answerCallback(callbackId, 'Стол полон (4/4) — начинаем раздачу!');
      await startMultiBlackjackRound(chat, table);
      return;
    }

    await transport.answerCallback(callbackId, `Ты занял бокс #${table.seats.length}!`);
    await renderLobby(chat, table);
    return;
  }

  if (sub === 'go') {
    if (table.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Раздача уже идёт!', true);
      return;
    }
    if (player.userId !== table.creatorId) {
      await transport.answerCallback(callbackId, 'Запустить раздачу может создатель стола!', true);
      return;
    }
    if (table.seats.length < 2) {
      await transport.answerCallback(callbackId, 'Нужно минимум 2 игрока за столом!', true);
      return;
    }

    await transport.answerCallback(callbackId, 'Раздача пошла!');
    await startMultiBlackjackRound(chat, table);
    return;
  }

  if (sub === 'stop') {
    if (table.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Раздача уже пошла — отменить нельзя!', true);
      return;
    }
    if (player.userId !== table.creatorId) {
      await transport.answerCallback(callbackId, 'Отменить стол может только его создатель!', true);
      return;
    }

    table.status = 'finished';
    bjTables.delete(table.id);
    for (const s of table.seats) {
      const p = chat.players[s.userId];
      if (p) refundPlayerStake(p, s.stake, s.isAllIn);
    }
    scheduleSave();

    await transport.answerCallback(callbackId, 'Стол закрыт, ставки возвращены.');
    if (table.messageId) {
      await transport.editMessage(
        chat.chatId,
        table.messageId,
        `❌ Общий стол Блэкджека закрыт создателем. Все ставки (${table.baseStake} 🪙) возвращены.`,
        [[{ text: '🏠 В меню', callbackData: 'menu' }]]
      );
    }
    return;
  }

  // Playing turn actions
  if (table.status !== 'playing') {
    await transport.answerCallback(callbackId, 'Раздача уже завершена.', true);
    return;
  }

  const currentSeat = table.seats[table.turnIndex];
  if (!currentSeat) {
    await finishMultiBlackjackRound(chat, table);
    return;
  }
  if (player.userId !== currentSeat.userId) {
    await transport.answerCallback(callbackId, `Сейчас ход игрока ${currentSeat.firstName}!`, true);
    return;
  }

  table.lastActionAt = Date.now();

  if (sub === 'hit') {
    const nextCard = table.deck.pop();
    if (nextCard) currentSeat.hand.push(nextCard);
    const score = calcScore(currentSeat.hand);
    if (score > 21) {
      currentSeat.status = 'bust';
      await transport.answerCallback(callbackId, `💥 Перебор (${score})!`);
    } else if (score === 21) {
      currentSeat.status = 'stood';
      await transport.answerCallback(callbackId, `🎯 Ровно 21!`);
    } else {
      await transport.answerCallback(callbackId, `Выпало [${nextCard?.rank}${nextCard?.suit}] (${score})`);
    }
    await advanceTurnOrFinish(chat, table);
    return;
  }

  if (sub === 'stand') {
    currentSeat.status = 'stood';
    await transport.answerCallback(callbackId, '✋ Хватит.');
    await advanceTurnOrFinish(chat, table);
    return;
  }

  if (sub === 'dbl') {
    if (currentSeat.hand.length !== 2) {
      await transport.answerCallback(callbackId, 'Удвоение доступно только на первых двух картах!', true);
      return;
    }
    if (player.balance < currentSeat.stake) {
      await transport.answerCallback(callbackId, 'Недостаточно фантиков для удвоения!', true);
      return;
    }

    player.balance -= currentSeat.stake;
    currentSeat.stake *= 2;
    currentSeat.doubled = true;
    const nextCard = table.deck.pop();
    if (nextCard) currentSeat.hand.push(nextCard);
    const score = calcScore(currentSeat.hand);
    currentSeat.status = score > 21 ? 'bust' : 'stood';
    scheduleSave();

    await transport.answerCallback(callbackId, `⚡ Удвоено! Итог бокса: ${score}`);
    await advanceTurnOrFinish(chat, table);
    return;
  }

  await transport.answerCallback(callbackId);
}
