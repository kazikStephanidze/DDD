import {
  BotTransport,
  InlineButton,
  InlineKeyboard,
  applyAutoDebtCollection,
  buildPostGameKeyboard,
  deductPlayerStake,
  displayName,
  formatDuration,
  getGhostRemainingMs,
  maybeSendZeroBalanceOffer,
  nextPhrase,
  playerLabel,
  shortId,
  sleep
} from '../engineShared.js';
import {
  recordGameOutcome,
  recordQuestProgress,
  unlockAchievement
} from '../features/profileQuests.js';
import {
  ChatState,
  LOBBY_IDLE_TTL_MS,
  PlayerState,
  addBotLog,
  getDb,
  scheduleSave
} from '../storage.js';
import {
  isServerlessRuntime,
  markRuntimeDirty,
  registerRuntimeAdapter,
  resolveRuntimeTransport
} from '../runtimeRegistry.js';

// =====================================
// 1. MULTIPLAYER CRASH ("ОБЩИЙ КРАШ ЧАТА")
// =====================================

interface CrashPassenger {
  userId: string;
  firstName: string;
  stake: number;
  isLastDodep: boolean;
  isAllIn: boolean;
  status: 'flying' | 'cashed' | 'busted';
  cashedMult?: number;
  payout?: number;
}

interface CrashRound {
  id: string;
  chatId: string;
  creatorId: string;
  entries: CrashPassenger[];
  crashPoint: number;
  currentMult: number;
  boardingTickCount?: number;
  status: 'boarding' | 'running' | 'finished';
  messageId: string | null;
  boardingEndsAt: number;
  flightStartedAt?: number;
  boardingTimer: NodeJS.Timeout | null;
  flyTimer: NodeJS.Timeout | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
}

const crashRounds = new Map<string, CrashRound>();

function getNewGameTransport(
  source?: 'telegram' | 'simulator',
  chatId?: string,
  tr?: BotTransport | null
): BotTransport | null {
  return resolveRuntimeTransport(source, chatId, tr);
}

export function findActiveCrashRoundForChat(chatId: string): CrashRound | null {
  for (const r of crashRounds.values()) {
    if (r.chatId === chatId && (r.status === 'boarding' || r.status === 'running')) {
      return r;
    }
  }
  return null;
}

function stepCrashMult(mult: number, steps = 1): number {
  let cur = mult;
  for (let i = 0; i < steps; i++) {
    cur = Math.round((cur + 0.12 + cur * 0.13) * 100) / 100;
  }
  return cur;
}

function buildCrashBoardingPayload(chat: ChatState, round: CrashRound): { text: string; keyboard: InlineKeyboard } {
  const leftSec = Math.max(0, Math.ceil((round.boardingEndsAt - Date.now()) / 1000));
  const totalBank = round.entries.reduce((s, e) => s + e.stake, 0);
  const pulseIcons = ['⏳', '🔥', '🚀'];
  const pulse = pulseIcons[(round.boardingTickCount || 0) % pulseIcons.length];
  const filledBars = Math.max(1, Math.min(6, 6 - Math.floor(leftSec / 2)));
  const bar = '▓'.repeat(filledBars) + '░'.repeat(6 - filledBars);

  const lines = [
    `🚀 ОБЩИЙ КРАШ ЧАТА — ПОСАДКА НА БОРТ!`,
    `${pulse} До взлёта: ~${leftSec} сек [${bar}] · Банк: ${totalBank} 🪙`,
    ``,
    `👨‍🚀 Пассажиры (${round.entries.length}):`
  ];
  for (const e of round.entries) {
    const p = chat.players[e.userId];
    lines.push(`• ${p ? playerLabel(chat, p) : e.firstName} — ${e.stake} 🪙`);
  }
  lines.push(``, `Запрыгивай в ракету до старта или жми «Запустить сейчас»!`);

  const kb: InlineKeyboard = [
    [
      { text: '➕ 100 🪙', callbackData: `cr:join:${round.id}:100` },
      { text: '➕ 250 🪙', callbackData: `cr:join:${round.id}:250` },
      { text: '➕ 500 🪙', callbackData: `cr:join:${round.id}:500` }
    ],
    [
      { text: '🔥 Ва-банк', callbackData: `cr:join:${round.id}:all` },
      { text: '🚀 Запустить сейчас!', callbackData: `cr:launch:${round.id}` }
    ],
    [
      ...(isServerlessRuntime() ? [{ text: '🔄 Обновить отсчёт', callbackData: `cr:tick:${round.id}` }] : []),
      { text: '❌ Отменить посадку', callbackData: `cr:cancel:${round.id}` }
    ]
  ];

  return { text: lines.join('\n'), keyboard: kb };
}

function buildCrashFlyingPayload(round: CrashRound): { text: string; keyboard: InlineKeyboard } {
  const heightBar = '🚀' + '━'.repeat(Math.min(12, Math.floor((round.currentMult - 1) * 4) + 1));
  const lines = [
    `🚀 ОБЩИЙ КРАШ ЧАТА — В ПОЛЁТЕ!`,
    ``,
    `${heightBar}  x${round.currentMult.toFixed(2)}`,
    ``
  ];

  for (const e of round.entries) {
    if (e.status === 'cashed') {
      lines.push(`✅ ${e.firstName} — снял x${(e.cashedMult || 1).toFixed(2)} (+${e.payout || 0} 🪙)`);
    } else {
      const potential = Math.round(e.stake * round.currentMult);
      lines.push(`🛫 ${e.firstName} — ${e.stake} 🪙 → сейчас ${potential} 🪙`);
    }
  }

  const kb: InlineKeyboard = [
    [{ text: `💰 ЗАБРАТЬ НА x${round.currentMult.toFixed(2)}`, callbackData: `cr:cash:${round.id}` }]
  ];
  if (isServerlessRuntime()) {
    kb.push([
      { text: '📈 Лететь (+1 шаг)', callbackData: `cr:tick:${round.id}` },
      { text: '⚡ Форсаж (+3 шага)', callbackData: `cr:boost:${round.id}` }
    ]);
  }
  return { text: lines.join('\n'), keyboard: kb };
}

function computeCrashMultAtNow(round: CrashRound, now = Date.now()): number {
  const startedAt = round.flightStartedAt || round.createdAt;
  const intervalMs = round.transportSource === 'simulator' ? 950 : 1450;
  const ticks = Math.max(0, Math.min(80, Math.floor((now - startedAt) / intervalMs)));
  let mult = 1.0;
  for (let i = 0; i < ticks; i++) {
    mult = stepCrashMult(mult, 1);
    if (mult >= round.crashPoint) return mult;
  }
  return mult;
}

async function syncServerlessCrashRound(chat: ChatState, round: CrashRound): Promise<'boarding' | 'running' | 'finished'> {
  if (!isServerlessRuntime()) return round.status;
  if (round.status === 'boarding' && Date.now() >= round.boardingEndsAt) {
    await launchCrashFlight(chat, round);
  }
  if (round.status === 'running') {
    const nextMult = computeCrashMultAtNow(round);
    if (nextMult >= round.crashPoint) {
      await finishCrashRound(chat, round, true);
      return 'finished';
    }
    if (nextMult > round.currentMult) {
      round.currentMult = nextMult;
      markRuntimeDirty();
      const tr = getNewGameTransport(round.transportSource, chat.chatId, round.transport);
      if (tr && round.messageId) {
        const payload = buildCrashFlyingPayload(round);
        await tr.editMessage(chat.chatId, round.messageId, payload.text, payload.keyboard, {
          isAnimation: true
        });
      }
    }
  }
  return round.status;
}

async function finishCrashRound(chat: ChatState, round: CrashRound, crashed: boolean): Promise<void> {
  if (round.status === 'finished') return;
  round.status = 'finished';
  if (round.boardingTimer) {
    clearTimeout(round.boardingTimer);
    round.boardingTimer = null;
  }
  if (round.flyTimer) {
    clearInterval(round.flyTimer);
    round.flyTimer = null;
  }
  crashRounds.delete(round.id);
  markRuntimeDirty();

  const bustedNames: string[] = [];
  const cashedLines: string[] = [];
  const autoCollectQueue: { player: PlayerState; net: number }[] = [];
  const zeroOfferQueue: PlayerState[] = [];
  let maxStakeForPost = 100;

  for (const e of round.entries) {
    maxStakeForPost = Math.max(maxStakeForPost, e.stake);
    const p = chat.players[e.userId];
    if (!p) continue;
    p.lastBetAmount = e.stake;
    p.lastGameType = 'crash';

    if (e.status === 'cashed') {
      cashedLines.push(`✅ ${e.firstName}: x${(e.cashedMult || 1).toFixed(2)} → +${e.payout || 0} 🪙`);
      const net = (e.payout || 0) - e.stake;
      if (net > 0) autoCollectQueue.push({ player: p, net });
    } else {
      e.status = 'busted';
      p.stats.totalLost += e.stake;
      p.lastActionWasLoss = true;
      p.lastActionWasLastDodep = false;
      recordGameOutcome(chat, p, 'crash', -e.stake, { isAllIn: e.isAllIn, isLastDodep: e.isLastDodep });
      bustedNames.push(`${e.firstName} (-${e.stake} 🪙)`);
      if (p.balance === 0) zeroOfferQueue.push(p);
    }
  }
  scheduleSave();

  const tr = getNewGameTransport(round.transportSource, chat.chatId, round.transport);
  addBotLog({
    source: tr?.source || 'telegram',
    chatId: chat.chatId,
    chatTitle: chat.title,
    event: crashed ? `Общий Краш: Взрыв на x${round.crashPoint.toFixed(2)}` : `Общий Краш: Все спрыгнули!`,
    detail: `Пассажиров: ${round.entries.length} · Забрали: ${cashedLines.length} · Сгорели: ${bustedNames.length}`
  });

  const phrase = crashed && bustedNames.length > 0 ? nextPhrase(chat, 'crashBust') : nextPhrase(chat, 'crashWinMid');
  const lines = [
    crashed
      ? `💥 КРАШ! РАКЕТА ВЗОРВАЛАСЬ НА x${round.crashPoint.toFixed(2)}!`
      : `🪂 ВСЕ ПАССАЖИРЫ УСПЕЛИ СПРЫГНУТЬ (взрыв был бы на x${round.crashPoint.toFixed(2)})!`,
    ``,
    ...(cashedLines.length > 0 ? [`🏆 Выпрыгнули с профитом:`, ...cashedLines, ``] : []),
    ...(bustedNames.length > 0 ? [`🔥 Сгорели на борту: ${bustedNames.join(', ')}`, ``] : []),
    phrase
  ];

  const kb = buildPostGameKeyboard('crash', maxStakeForPost, bustedNames.length > 0);
  if (tr) {
    if (round.messageId) {
      await tr.editMessage(chat.chatId, round.messageId, lines.join('\n'), kb);
    } else {
      await tr.sendMessage(chat.chatId, lines.join('\n'), kb);
    }

    for (const item of autoCollectQueue) {
      await applyAutoDebtCollection(tr, chat, item.player, item.net);
    }
    for (const zp of zeroOfferQueue) {
      await maybeSendZeroBalanceOffer(tr, chat, zp);
    }
  }
}

async function launchCrashFlight(chat: ChatState, round: CrashRound): Promise<void> {
  if (round.status !== 'boarding') return;
  if (round.boardingTimer) {
    clearTimeout(round.boardingTimer);
    round.boardingTimer = null;
  }
  if (round.entries.length === 0) {
    round.status = 'finished';
    crashRounds.delete(round.id);
    markRuntimeDirty();
    return;
  }

  round.status = 'running';
  round.flightStartedAt = Date.now();
  if (isServerlessRuntime()) {
    if (round.crashPoint <= 1.05) {
      await finishCrashRound(chat, round, true);
      return;
    }
    round.currentMult = round.crashPoint > 1.12 ? 1.12 : 1.05;
  }
  markRuntimeDirty();
  const tr = getNewGameTransport(round.transportSource, chat.chatId, round.transport);
  const payload = buildCrashFlyingPayload(round);
  if (tr) {
    if (round.messageId) {
      await tr.editMessage(chat.chatId, round.messageId, payload.text, payload.keyboard);
    } else {
      round.messageId = await tr.sendMessage(chat.chatId, payload.text, payload.keyboard);
    }
  }

  if (isServerlessRuntime()) {
    return;
  }

  const intervalMs = (tr?.source || round.transportSource) === 'telegram' ? 1450 : 950;
  round.flyTimer = setInterval(async () => {
    try {
      if (round.status !== 'running') {
        if (round.flyTimer) {
          clearInterval(round.flyTimer);
          round.flyTimer = null;
        }
        return;
      }

      const nextMult = stepCrashMult(round.currentMult, 1);
      if (nextMult >= round.crashPoint) {
        await finishCrashRound(chat, round, true);
        return;
      }

      round.currentMult = nextMult;
      markRuntimeDirty();
      const tick = buildCrashFlyingPayload(round);
      const activeTr = getNewGameTransport(round.transportSource, chat.chatId, round.transport);
      if (round.messageId && activeTr) {
        await activeTr.editMessage(chat.chatId, round.messageId, tick.text, tick.keyboard, {
          isAnimation: true
        });
      }
    } catch (err: any) {
      console.error('[Crash] flyTimer error:', err?.message || err);
    }
  }, intervalMs);
}

export async function startOrJoinMultiplayerCrash(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  stake: number,
  isLastDodep: boolean,
  messageId?: string
): Promise<void> {
  const existing = findActiveCrashRoundForChat(chat.chatId);
  if (existing) {
    if (existing.status === 'running') {
      const text = `🚀 Ракета в этом чате уже летит (сейчас x${existing.currentMult.toFixed(2)})! Дождись окончания полёта, чтобы зайти в следующий борт.`;
      if (messageId) {
        await transport.editMessage(chat.chatId, messageId, text, [[{ text: '🏠 В меню', callbackData: 'menu' }]]);
      } else {
        await transport.sendMessage(chat.chatId, text, [[{ text: '🏠 В меню', callbackData: 'menu' }]]);
      }
      return;
    }

    if (existing.entries.some((e) => e.userId === player.userId)) {
      const view = buildCrashBoardingPayload(chat, existing);
      if (messageId && messageId !== existing.messageId) {
        await transport.editMessage(chat.chatId, messageId, `Ты уже в ракете! Залетай в общее сообщение посадки ниже.`, [
          [{ text: '🏠 В меню', callbackData: 'menu' }]
        ]);
      }
      if (existing.messageId) {
        await transport.editMessage(chat.chatId, existing.messageId, view.text, view.keyboard);
      }
      return;
    }

    const isAllIn = deductPlayerStake(player, stake);
    existing.entries.push({
      userId: player.userId,
      firstName: displayName(player),
      stake,
      isLastDodep,
      isAllIn,
      status: 'flying'
    });
    markRuntimeDirty();
    scheduleSave();

    const view = buildCrashBoardingPayload(chat, existing);
    if (existing.messageId) {
      await transport.editMessage(chat.chatId, existing.messageId, view.text, view.keyboard);
    }
    if (messageId && messageId !== existing.messageId) {
      await transport.editMessage(
        chat.chatId,
        messageId,
        `🚀 Ты на борту общей ракеты (ставка ${stake} 🪙)! Смотри отсчёт и жми «Забрать» в общем сообщении посадки.`,
        [[{ text: '🏠 В меню', callbackData: 'menu' }]]
      );
    }
    return;
  }

  const isAllIn = deductPlayerStake(player, stake);
  scheduleSave();

  const u = Math.random();
  let crashPoint = u < 0.05 ? 1.0 : Math.min(35, Math.max(1.08, 0.94 / (1 - u)));
  crashPoint = Math.round(crashPoint * 100) / 100;

  const rid = shortId();
  const boardingWindowMs = 12_000;
  const round: CrashRound = {
    id: rid,
    chatId: chat.chatId,
    creatorId: player.userId,
    entries: [
      {
        userId: player.userId,
        firstName: displayName(player),
        stake,
        isLastDodep,
        isAllIn,
        status: 'flying'
      }
    ],
    crashPoint,
    currentMult: 1.0,
    boardingTickCount: 0,
    status: 'boarding',
    messageId: messageId || null,
    boardingEndsAt: Date.now() + boardingWindowMs,
    boardingTimer: null,
    flyTimer: null,
    transportSource: transport.source,
    transport,
    createdAt: Date.now()
  };
  crashRounds.set(rid, round);
  markRuntimeDirty();

  const view = buildCrashBoardingPayload(chat, round);
  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    round.messageId = messageId;
  } else {
    round.messageId = await transport.sendMessage(chat.chatId, view.text, view.keyboard);
  }

  if (!isServerlessRuntime()) {
    round.boardingTimer = setTimeout(() => {
      void launchCrashFlight(chat, round);
    }, boardingWindowMs);
  }
}

export async function handleCrashCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];
  const rid = parts[2];
  const round = crashRounds.get(rid);

  if (!round) {
    await transport.answerCallback(callbackId, 'Этот полёт уже завершился и ушёл в историю.', true);
    return;
  }

  if (sub === 'tick' || sub === 'boost') {
    if (round.status === 'boarding') {
      if (Date.now() >= round.boardingEndsAt) {
        await transport.answerCallback(callbackId, '🔥 Время вышло — взлетаем!');
        await launchCrashFlight(chat, round);
        return;
      }
      round.boardingTickCount = (round.boardingTickCount || 0) + 1;
      markRuntimeDirty();
      await transport.answerCallback(callbackId, '⏱ Отсчёт обновлён!');
      const payload = buildCrashBoardingPayload(chat, round);
      await transport.editMessage(chat.chatId, round.messageId || messageId, payload.text, payload.keyboard);
      return;
    }

    if (round.status === 'running') {
      const steps = sub === 'boost' ? 3 : 1;
      const timeBasedMult = computeCrashMultAtNow(round);
      const steppedMult = stepCrashMult(round.currentMult, steps);
      const nextMult = Math.max(timeBasedMult, steppedMult);

      if (nextMult >= round.crashPoint) {
        await transport.answerCallback(callbackId, `💥 Ракета взорвалась на x${round.crashPoint.toFixed(2)}!`, true);
        await finishCrashRound(chat, round, true);
        return;
      }

      round.currentMult = nextMult;
      markRuntimeDirty();
      await transport.answerCallback(
        callbackId,
        sub === 'boost' ? `⚡ Форсаж! Курс x${round.currentMult.toFixed(2)}` : `🚀 Курс вырос: x${round.currentMult.toFixed(2)}`
      );
      const payload = buildCrashFlyingPayload(round);
      await transport.editMessage(chat.chatId, round.messageId || messageId, payload.text, payload.keyboard);
      return;
    }

    await transport.answerCallback(callbackId, 'Этот полёт уже завершён.', true);
    return;
  }

  if (sub === 'join') {
    if (isServerlessRuntime() && round.status === 'boarding' && Date.now() >= round.boardingEndsAt) {
      await syncServerlessCrashRound(chat, round);
    }
    if (round.status !== 'boarding') {
      await transport.answerCallback(callbackId, 'Посадка закрыта — ракета уже в воздухе!', true);
      return;
    }
    if (round.entries.some((e) => e.userId === player.userId)) {
      await transport.answerCallback(callbackId, 'Ты уже сидишь в этой ракете!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Ты Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    if (player.balance <= 0) {
      await transport.answerCallback(callbackId, 'На счету 0 🪙! Возьми бонус или займ.', true);
      return;
    }

    const raw = parts[3] || '100';
    const stake = raw === 'all' ? player.balance : parseInt(raw, 10);
    if (Number.isNaN(stake) || stake <= 0 || stake > player.balance) {
      await transport.answerCallback(callbackId, `Недостаточно фантиков (баланс ${player.balance} 🪙)!`, true);
      return;
    }

    const isAllIn = deductPlayerStake(player, stake);
    round.entries.push({
      userId: player.userId,
      firstName: displayName(player),
      stake,
      isLastDodep: false,
      isAllIn,
      status: 'flying'
    });
    markRuntimeDirty();
    scheduleSave();

    await transport.answerCallback(callbackId, `🚀 Ты на борту со ставкой ${stake} 🪙!`);
    const view = buildCrashBoardingPayload(chat, round);
    await transport.editMessage(chat.chatId, round.messageId || messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'launch') {
    if (round.status !== 'boarding') {
      await transport.answerCallback(callbackId, 'Ракета уже летит!', true);
      return;
    }
    if (!round.entries.some((e) => e.userId === player.userId)) {
      await transport.answerCallback(callbackId, 'Запустить досрочно может пассажир на борту!', true);
      return;
    }
    await transport.answerCallback(callbackId, '🔥 Взлетаем прямо сейчас!');
    await launchCrashFlight(chat, round);
    return;
  }

  if (sub === 'cancel') {
    if (round.status !== 'boarding') {
      await transport.answerCallback(callbackId, 'Поздно отменять, турбины уже в небе!', true);
      return;
    }
    if (round.creatorId !== player.userId) {
      await transport.answerCallback(callbackId, 'Отменить посадку может только инициатор полёта!', true);
      return;
    }
    if (round.boardingTimer) clearTimeout(round.boardingTimer);
    round.status = 'finished';
    crashRounds.delete(rid);
    markRuntimeDirty();

    for (const e of round.entries) {
      const p = chat.players[e.userId];
      if (p) p.balance += e.stake;
    }
    scheduleSave();

    await transport.answerCallback(callbackId, 'Посадка отменена, ставки возвращены.');
    await transport.editMessage(
      chat.chatId,
      round.messageId || messageId,
      `❌ Запуск общей ракеты отменён. Все ставки (${round.entries.length} чел.) возвращены.`,
      [[{ text: '🏠 В меню', callbackData: 'menu' }]]
    );
    return;
  }

  if (sub === 'cash') {
    if (isServerlessRuntime()) {
      const state = await syncServerlessCrashRound(chat, round);
      if (state === 'finished') {
        await transport.answerCallback(
          callbackId,
          `💥 Поздно! Ракета уже взорвалась на x${round.crashPoint.toFixed(2)}.`,
          true
        );
        return;
      }
    }
    if (round.status !== 'running') {
      await transport.answerCallback(callbackId, 'Раунд уже завершён!', true);
      return;
    }
    const entry = round.entries.find((e) => e.userId === player.userId);
    if (!entry) {
      await transport.answerCallback(callbackId, 'Тебя нет на борту этого полёта!', true);
      return;
    }
    if (entry.status !== 'flying') {
      await transport.answerCallback(callbackId, 'Ты уже спрыгнул с ракеты!', true);
      return;
    }

    const winMult = round.currentMult;
    const payout = Math.round(entry.stake * winMult);
    const netProfit = payout - entry.stake;

    entry.status = 'cashed';
    entry.cashedMult = winMult;
    entry.payout = payout;

    player.balance += payout;
    player.lastBetAmount = entry.stake;
    player.lastGameType = 'crash';
    player.stats.totalWon += Math.max(0, netProfit);
    if (winMult > player.stats.maxCrashMultiplier) {
      player.stats.maxCrashMultiplier = winMult;
    }
    if (entry.isLastDodep && player.lastActionWasLoss) {
      player.stats.lastDodepWins += 1;
    }
    player.lastActionWasLoss = false;
    player.lastActionWasLastDodep = false;

    recordGameOutcome(chat, player, 'crash', Math.max(0, netProfit), {
      isAllIn: entry.isAllIn,
      isLastDodep: entry.isLastDodep
    });
    if (winMult >= 2.0) recordQuestProgress(player, 'crash_x2', 1);
    if (winMult >= 5.0) unlockAchievement(chat, player, 'astronaut');
    markRuntimeDirty();
    scheduleSave();

    await transport.answerCallback(callbackId, `🪂 Забрал x${winMult.toFixed(2)} (+${payout} 🪙)!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: entry.firstName,
      event: `Краш: Кэшаут x${winMult.toFixed(2)}`,
      detail: `Ставка ${entry.stake} → Выигрыш ${payout} 🪙`
    });

    const anyStillFlying = round.entries.some((e) => e.status === 'flying');
    if (!anyStillFlying) {
      await finishCrashRound(chat, round, false);
    } else {
      const tick = buildCrashFlyingPayload(round);
      await transport.editMessage(chat.chatId, round.messageId || messageId, tick.text, tick.keyboard);
    }
    return;
  }

  await transport.answerCallback(callbackId);
}

// =====================================
// 2. THIMBLES ("НАПЁРСТКИ — 3 СТАКАНА")
// =====================================

interface ThimblesSession {
  id: string;
  chatId: string;
  userId: string;
  userName: string;
  stake: number;
  isLastDodep: boolean;
  isAllIn: boolean;
  ballCup: number; // 0 | 1 | 2
  status: 'playing' | 'finished';
  createdAt: number;
}

const thimblesSessions = new Map<string, ThimblesSession>();

export async function startThimblesGame(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  stake: number,
  isLastDodep: boolean,
  messageId?: string
): Promise<void> {
  const isAllIn = deductPlayerStake(player, stake);
  scheduleSave();

  const ballCup = Math.floor(Math.random() * 3);
  const sid = shortId();
  thimblesSessions.set(sid, {
    id: sid,
    chatId: chat.chatId,
    userId: player.userId,
    userName: displayName(player),
    stake,
    isLastDodep,
    isAllIn,
    ballCup,
    status: 'playing',
    createdAt: Date.now()
  });
  markRuntimeDirty();

  const frameDelay = transport.source === 'telegram' ? 550 : 320;
  const sendOrEdit = async (text: string, kb?: InlineKeyboard): Promise<string | null> => {
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, text, kb, { isAnimation: !kb });
      return messageId;
    }
    return transport.sendMessage(chat.chatId, text, kb);
  };

  const f1 = [
    `🥃 НАПЁРСТКИ (3 СТАКАНА)`,
    `👤 ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
    ``,
    `🟡 Шарик спрятан! Кручу стаканы...`,
    `[ 🥃 ]   ⇄   [ 🥃 ]   ⇄   [ 🥃 ]`
  ].join('\n');
  const panelId = await sendOrEdit(f1);
  await sleep(frameDelay);

  const f2 = [
    `🥃 НАПЁРСТКИ (3 СТАКАНА)`,
    `👤 ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
    ``,
    `🌀 Стаканы меняются местами ещё быстрее...`,
    `[ 🥃 1 ]   ⚡   [ 🥃 2 ]   ⚡   [ 🥃 3 ]`
  ].join('\n');
  if (panelId) {
    await transport.editMessage(chat.chatId, panelId, f2, undefined, { isAnimation: true });
    await sleep(frameDelay);
  }

  const readyText = [
    `🥃 НАПЁРСТКИ — ГДЕ ЗОЛОТОЙ ШАРИК?`,
    `👤 ${playerLabel(chat, player)} | Ставка: ${stake} 🪙 (приз x2.85 = ${Math.round(stake * 2.85)} 🪙)`,
    ``,
    `[ 🥃 1 ]      [ 🥃 2 ]      [ 🥃 3 ]`,
    ``,
    `Твой выбор — под каким стаканом шарик?`
  ].join('\n');
  const kb: InlineKeyboard = [
    [
      { text: '🥃 Стакан 1', callbackData: `th:pick:${sid}:0` },
      { text: '🥃 Стакан 2', callbackData: `th:pick:${sid}:1` },
      { text: '🥃 Стакан 3', callbackData: `th:pick:${sid}:2` }
    ]
  ];
  if (panelId) {
    await transport.editMessage(chat.chatId, panelId, readyText, kb);
  } else {
    await transport.sendMessage(chat.chatId, readyText, kb);
  }
}

export async function handleThimblesCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  if (parts[1] !== 'pick') {
    await transport.answerCallback(callbackId);
    return;
  }
  const sid = parts[2];
  const pick = parseInt(parts[3], 10);
  const session = thimblesSessions.get(sid);
  if (!session || session.status !== 'playing') {
    await transport.answerCallback(callbackId, 'Этот раунд напёрстков уже сыгран.', true);
    return;
  }
  if (session.userId !== player.userId) {
    await transport.answerCallback(callbackId, 'Это чужой стол напёрстков!', true);
    return;
  }

  session.status = 'finished';
  thimblesSessions.delete(sid);

  const won = pick === session.ballCup;
  const payout = won ? Math.round(session.stake * 2.85) : 0;
  const netProfit = payout - session.stake;

  player.lastBetAmount = session.stake;
  player.lastGameType = 'thimbles';

  if (won) {
    player.balance += payout;
    player.stats.totalWon += netProfit;
    if (session.isLastDodep && player.lastActionWasLoss) {
      player.stats.lastDodepWins += 1;
    }
    player.lastActionWasLoss = false;
  } else {
    player.stats.totalLost += session.stake;
    player.lastActionWasLoss = true;
  }
  player.lastActionWasLastDodep = false;
  recordGameOutcome(chat, player, 'thimbles', netProfit, {
    isAllIn: session.isAllIn,
    isLastDodep: session.isLastDodep
  });
  scheduleSave();

  await transport.answerCallback(callbackId, won ? `🟡 Угадал! +${payout} 🪙 (x2.85)!` : '💨 Пусто под этим стаканом!');
  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: session.userName,
    event: won ? 'Напёрстки: Победа (x2.85)' : 'Напёрстки: Мимо',
    detail: won ? `Ставка ${session.stake} → +${payout} 🪙` : `Сгорело ${session.stake} 🪙 (шарик под #${session.ballCup + 1})`
  });

  const cupsVisual = [0, 1, 2]
    .map((idx) => (idx === session.ballCup ? `[ 🟡 ${idx + 1} ]` : `[ ❌ ${idx + 1} ]`))
    .join('   ');

  const finalText = [
    `🥃 НАПЁРСТКИ — ИТОГ`,
    `👤 Игрок: ${playerLabel(chat, player)} | Выбор: Стакан #${pick + 1}`,
    ``,
    cupsVisual,
    ``,
    won
      ? `🏆 ПОБЕДА (x2.85)! Забираешь ${payout} фантиков (чистыми +${netProfit})!`
      : `💀 ПУСТО! Шарик был под стаканом #${session.ballCup + 1}. Сгорело ${session.stake} 🪙.`,
    `🪙 Баланс: ${player.balance} фантиков`,
    ``,
    nextPhrase(chat, won ? 'thimblesWin' : 'thimblesLoss')
  ].join('\n');

  await transport.editMessage(
    chat.chatId,
    messageId,
    finalText,
    buildPostGameKeyboard('thimbles', session.stake, !won, player)
  );

  if (netProfit > 0) {
    await applyAutoDebtCollection(transport, chat, player, netProfit);
  } else if (player.balance === 0) {
    await maybeSendZeroBalanceOffer(transport, chat, player);
  }
}

// =====================================
// 3. ROCK PAPER SCISSORS ("К-Н-Б" — SOLO & PvP 1x1)
// =====================================

type RpsMove = 'r' | 'p' | 's';

const RPS_META: Record<RpsMove, { emoji: string; label: string; beats: RpsMove }> = {
  r: { emoji: '🪨', label: 'Камень', beats: 's' },
  s: { emoji: '✂️', label: 'Ножницы', beats: 'p' },
  p: { emoji: '📄', label: 'Бумага', beats: 'r' }
};

interface RpsSoloSession {
  id: string;
  chatId: string;
  userId: string;
  stake: number;
  isLastDodep: boolean;
  isAllIn: boolean;
  status: 'playing' | 'finished';
  createdAt: number;
}

interface RpsPvpLobby {
  id: string;
  chatId: string;
  creatorId: string;
  creatorName: string;
  opponentId: string | null;
  opponentName: string | null;
  stake: number;
  isLastDodep: boolean;
  isAllIn: boolean;
  moves: Record<string, RpsMove>;
  status: 'waiting' | 'playing' | 'finished';
  messageId: string | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
}

const rpsSoloSessions = new Map<string, RpsSoloSession>();
const rpsPvpLobbies = new Map<string, RpsPvpLobby>();

export async function startRpsMenu(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  stake: number,
  isLastDodep: boolean,
  messageId?: string
): Promise<void> {
  const ld = isLastDodep ? '1' : '0';
  const text = [
    `🪨✂️📄 КАМЕНЬ — НОЖНИЦЫ — БУМАГА`,
    `👤 Игрок: ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
    `🏆 Победа в любом режиме: x2 (${stake * 2} 🪙)!`,
    ``,
    `Выбери формат дуэли:`
  ].join('\n');
  const kb: InlineKeyboard = [
    [{ text: '🤖 Против Дяди Депа (сразу)', callbackData: `rps:bot:${stake}:${ld}` }],
    [{ text: '⚔️ Бросить вызов чату (PvP 1×1)', callbackData: `rps:pvpnew:${stake}:${ld}` }],
    [{ text: '↩️ В меню', callbackData: 'menu' }]
  ];
  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, text, kb);
  } else {
    await transport.sendMessage(chat.chatId, text, kb);
  }
}

export async function handleRpsCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];

  if (sub === 'bot') {
    const stake = parseInt(parts[2], 10);
    const isLastDodep = parts[3] === '1';
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    if (player.balance < stake || stake <= 0) {
      await transport.answerCallback(callbackId, 'Недостаточно фантиков!', true);
      return;
    }

    const isAllIn = deductPlayerStake(player, stake);
    scheduleSave();

    const sid = shortId();
    rpsSoloSessions.set(sid, {
      id: sid,
      chatId: chat.chatId,
      userId: player.userId,
      stake,
      isLastDodep,
      isAllIn,
      status: 'playing',
      createdAt: Date.now()
    });
    markRuntimeDirty();

    await transport.answerCallback(callbackId, 'Выбирай жест!');
    const botText = [
      `🪨✂️📄 К-Н-Б ПРОТИВ ДЯДИ ДЕПА`,
      `👤 ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
      ``,
      `Дядя Деп уже сжал кулак за спиной. Выбрасывай жест:`
    ].join('\n');
    const botKb: InlineKeyboard = [
      [
        { text: '🪨 Камень', callbackData: `rps:bpick:${sid}:r` },
        { text: '✂️ Ножницы', callbackData: `rps:bpick:${sid}:s` },
        { text: '📄 Бумага', callbackData: `rps:bpick:${sid}:p` }
      ]
    ];
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, botText, botKb);
    } else {
      await transport.sendMessage(chat.chatId, botText, botKb);
    }
    return;
  }

  if (sub === 'bpick') {
    const sid = parts[2];
    const move = parts[3] as RpsMove;
    const session = rpsSoloSessions.get(sid);
    if (!session || session.status !== 'playing') {
      await transport.answerCallback(callbackId, 'Эта партия К-Н-Б уже завершена.', true);
      return;
    }
    if (session.userId !== player.userId) {
      await transport.answerCallback(callbackId, 'Не твоя дуэль!', true);
      return;
    }

    session.status = 'finished';
    rpsSoloSessions.delete(sid);

    const moves: RpsMove[] = ['r', 's', 'p'];
    const botMove = moves[Math.floor(Math.random() * 3)];

    player.lastBetAmount = session.stake;
    player.lastGameType = 'rps';

    let outcome: 'win' | 'loss' | 'draw' = 'draw';
    if (RPS_META[move].beats === botMove) outcome = 'win';
    else if (RPS_META[botMove].beats === move) outcome = 'loss';

    if (outcome === 'win') {
      const payout = session.stake * 2;
      player.balance += payout;
      player.stats.totalWon += session.stake;
      if (session.isLastDodep && player.lastActionWasLoss) {
        player.stats.lastDodepWins += 1;
      }
      player.lastActionWasLoss = false;
    } else if (outcome === 'loss') {
      player.stats.totalLost += session.stake;
      player.lastActionWasLoss = true;
    } else {
      player.balance += session.stake;
      player.lastActionWasLoss = false;
    }
    player.lastActionWasLastDodep = false;
    recordGameOutcome(
      chat,
      player,
      'rps',
      outcome === 'win' ? session.stake : outcome === 'loss' ? -session.stake : 0,
      { isAllIn: session.isAllIn, isLastDodep: session.isLastDodep }
    );
    scheduleSave();

    await transport.answerCallback(
      callbackId,
      outcome === 'win' ? `🏆 Победа x2 (+${session.stake * 2} 🪙)!` : outcome === 'draw' ? '🤝 Ничья!' : '💀 Проигрыш!'
    );

    const pMeta = RPS_META[move];
    const bMeta = RPS_META[botMove];
    const header =
      outcome === 'win'
        ? `🏆 ПОБЕДА (x2)! Забираешь ${session.stake * 2} фантиков!`
        : outcome === 'draw'
          ? `🤝 НИЧЬЯ! Ставка ${session.stake} 🪙 возвращена.`
          : `💀 ПРОИГРЫШ! Дядя Деп переиграл тебя на ${session.stake} 🪙.`;

    const phrase = outcome === 'loss' ? nextPhrase(chat, 'rpsLoss') : nextPhrase(chat, 'rpsWin');
    await transport.editMessage(
      chat.chatId,
      messageId,
      [
        `🪨✂️📄 К-Н-Б ПРОТИВ ДЯДИ ДЕПА — ИТОГ`,
        `🙋 ${playerLabel(chat, player)}: ${pMeta.emoji} ${pMeta.label}`,
        `🧔‍♂️ Дядя Деп: ${bMeta.emoji} ${bMeta.label}`,
        ``,
        header,
        `🪙 Баланс: ${player.balance} фантиков`,
        ``,
        phrase
      ].join('\n'),
      buildPostGameKeyboard('rps', session.stake, outcome === 'loss', player)
    );

    if (outcome === 'win') {
      await applyAutoDebtCollection(transport, chat, player, session.stake);
    } else if (outcome === 'loss' && player.balance === 0) {
      await maybeSendZeroBalanceOffer(transport, chat, player);
    }
    return;
  }

  if (sub === 'pvpnew') {
    const stake = parseInt(parts[2], 10);
    const isLastDodep = parts[3] === '1';
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    if (player.balance < stake || stake <= 0) {
      await transport.answerCallback(callbackId, 'Недостаточно фантиков!', true);
      return;
    }

    const isAllIn = deductPlayerStake(player, stake);
    scheduleSave();

    const sid = shortId();
    const lobby: RpsPvpLobby = {
      id: sid,
      chatId: chat.chatId,
      creatorId: player.userId,
      creatorName: displayName(player),
      opponentId: null,
      opponentName: null,
      stake,
      isLastDodep,
      isAllIn,
      moves: {},
      status: 'waiting',
      messageId: messageId || null,
      transportSource: transport.source,
      transport,
      createdAt: Date.now()
    };
    rpsPvpLobbies.set(sid, lobby);
    markRuntimeDirty();

    await transport.answerCallback(callbackId, 'Вызов К-Н-Б открыт!');
    const pvpText = [
      `🪨✂️📄 ВЫЗОВ К-Н-Б 1 НА 1 (PvP)`,
      `⚔️ Бросает вызов: ${playerLabel(chat, player)}`,
      `🪙 Ставка: ${stake} 🪙 (банк победителю: ${stake * 2} 🪙)`,
      ``,
      `Ждём второго смельчака из чата!`
    ].join('\n');
    const pvpKb: InlineKeyboard = [
      [{ text: `🤝 Принять вызов (${stake} 🪙)`, callbackData: `rps:pvpjoin:${sid}` }],
      [{ text: '❌ Отменить (создатель)', callbackData: `rps:cancel:${sid}` }]
    ];
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, pvpText, pvpKb);
    } else {
      lobby.messageId = await transport.sendMessage(chat.chatId, pvpText, pvpKb);
    }
    return;
  }

  if (sub === 'pvpjoin') {
    const sid = parts[2];
    const lobby = rpsPvpLobbies.get(sid);
    if (!lobby || lobby.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Вызов уже принят или отменён!', true);
      return;
    }
    if (lobby.creatorId === player.userId) {
      await transport.answerCallback(callbackId, 'Нельзя играть К-Н-Б с самим собой!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    if (player.balance < lobby.stake) {
      await transport.answerCallback(callbackId, `Нужно ${lobby.stake} 🪙, у тебя ${player.balance} 🪙.`, true);
      return;
    }

    deductPlayerStake(player, lobby.stake);
    lobby.opponentId = player.userId;
    lobby.opponentName = displayName(player);
    lobby.status = 'playing';
    scheduleSave();

    await transport.answerCallback(callbackId, 'Вызов принят! Делай ход!');
    await transport.editMessage(
      chat.chatId,
      lobby.messageId || messageId,
      [
        `🪨✂️📄 ДУЭЛЬ К-Н-Б: ${lobby.creatorName} vs ${lobby.opponentName}`,
        `💰 Банк: ${lobby.stake * 2} 🪙`,
        ``,
        `Оба участника нажимают свой секретный жест ниже:`
      ].join('\n'),
      [
        [
          { text: '🪨 Камень', callbackData: `rps:pmove:${sid}:r` },
          { text: '✂️ Ножницы', callbackData: `rps:pmove:${sid}:s` },
          { text: '📄 Бумага', callbackData: `rps:pmove:${sid}:p` }
        ]
      ]
    );
    return;
  }

  if (sub === 'cancel') {
    const sid = parts[2];
    const lobby = rpsPvpLobbies.get(sid);
    if (!lobby || lobby.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Поздно отменять!', true);
      return;
    }
    if (lobby.creatorId !== player.userId) {
      await transport.answerCallback(callbackId, 'Отменить может только создатель вызова!', true);
      return;
    }
    const creator = chat.players[lobby.creatorId];
    if (creator) creator.balance += lobby.stake;
    lobby.status = 'finished';
    rpsPvpLobbies.delete(sid);
    scheduleSave();

    await transport.answerCallback(callbackId, 'Вызов отменён, ставка возвращена.');
    await transport.editMessage(
      chat.chatId,
      lobby.messageId || messageId,
      `❌ Вызов К-Н-Б отменён создателем. Ставка ${lobby.stake} 🪙 возвращена.`,
      [[{ text: '🏠 В меню', callbackData: 'menu' }]]
    );
    return;
  }

  if (sub === 'pmove') {
    const sid = parts[2];
    const move = parts[3] as RpsMove;
    const lobby = rpsPvpLobbies.get(sid);
    if (!lobby || lobby.status !== 'playing') {
      await transport.answerCallback(callbackId, 'Эта дуэль уже завершена!', true);
      return;
    }
    if (player.userId !== lobby.creatorId && player.userId !== lobby.opponentId) {
      await transport.answerCallback(callbackId, 'Это дуэль двух других игроков!', true);
      return;
    }
    if (lobby.moves[player.userId]) {
      await transport.answerCallback(callbackId, 'Ты уже выбрал жест! Ждём второго игрока.', true);
      return;
    }

    lobby.moves[player.userId] = move;
    const m1 = lobby.moves[lobby.creatorId];
    const m2 = lobby.opponentId ? lobby.moves[lobby.opponentId] : undefined;

    if (!m1 || !m2) {
      await transport.answerCallback(callbackId, `Секретно выбран ${RPS_META[move].emoji} ${RPS_META[move].label}! Ждём соперника.`);
      const waitedName = m1 ? lobby.opponentName : lobby.creatorName;
      await transport.editMessage(
        chat.chatId,
        lobby.messageId || messageId,
        [
          `🪨✂️📄 ДУЭЛЬ К-Н-Б: ${lobby.creatorName} vs ${lobby.opponentName}`,
          `💰 Банк: ${lobby.stake * 2} 🪙`,
          ``,
          `✅ Один из игроков уже сделал выбор! Ждём: ${waitedName}`
        ].join('\n'),
        [
          [
            { text: '🪨 Камень', callbackData: `rps:pmove:${sid}:r` },
            { text: '✂️ Ножницы', callbackData: `rps:pmove:${sid}:s` },
            { text: '📄 Бумага', callbackData: `rps:pmove:${sid}:p` }
          ]
        ]
      );
      return;
    }

    // Both moved!
    if (m1 === m2) {
      lobby.moves = {};
      await transport.answerCallback(callbackId, '🤝 Ничья! Переигрываем раунд!');
      await transport.editMessage(
        chat.chatId,
        lobby.messageId || messageId,
        [
          `🪨✂️📄 НИЧЬЯ (${RPS_META[m1].emoji} vs ${RPS_META[m2].emoji}) — ПЕРЕИГРЫВАЕМ!`,
          `${lobby.creatorName} vs ${lobby.opponentName} · Банк: ${lobby.stake * 2} 🪙`,
          ``,
          `Выбирайте жест заново:`
        ].join('\n'),
        [
          [
            { text: '🪨 Камень', callbackData: `rps:pmove:${sid}:r` },
            { text: '✂️ Ножницы', callbackData: `rps:pmove:${sid}:s` },
            { text: '📄 Бумага', callbackData: `rps:pmove:${sid}:p` }
          ]
        ]
      );
      return;
    }

    const creatorWon = RPS_META[m1].beats === m2;
    const winnerId = creatorWon ? lobby.creatorId : lobby.opponentId!;
    const loserId = creatorWon ? lobby.opponentId! : lobby.creatorId;
    const winnerName = creatorWon ? lobby.creatorName : lobby.opponentName!;
    const loserName = creatorWon ? lobby.opponentName! : lobby.creatorName;
    const pot = lobby.stake * 2;

    lobby.status = 'finished';
    rpsPvpLobbies.delete(sid);

    const winnerP = chat.players[winnerId];
    const loserP = chat.players[loserId];
    if (winnerP) {
      winnerP.balance += pot;
      winnerP.stats.totalWon += lobby.stake;
      winnerP.lastBetAmount = lobby.stake;
      winnerP.lastGameType = 'rps';
      winnerP.lastActionWasLoss = false;
      recordGameOutcome(chat, winnerP, 'rps', lobby.stake);
    }
    if (loserP) {
      loserP.stats.totalLost += lobby.stake;
      loserP.lastBetAmount = lobby.stake;
      loserP.lastGameType = 'rps';
      loserP.lastActionWasLoss = true;
      recordGameOutcome(chat, loserP, 'rps', -lobby.stake);
    }
    scheduleSave();

    await transport.answerCallback(callbackId, `🏆 Победил ${winnerName}!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: winnerName,
      event: `К-Н-Б PvP: ${winnerName} vs ${loserName}`,
      detail: `Банк ${pot} 🪙 забрал ${winnerName}`
    });

    await transport.editMessage(
      chat.chatId,
      lobby.messageId || messageId,
      [
        `🪨✂️📄 ДУЭЛЬ К-Н-Б — ФИНАЛ!`,
        `• ${lobby.creatorName}: ${RPS_META[m1].emoji} ${RPS_META[m1].label}`,
        `• ${lobby.opponentName}: ${RPS_META[m2].emoji} ${RPS_META[m2].label}`,
        ``,
        `🏆 ПОБЕДИТЕЛЬ: ${winnerName} — забирает банк ${pot} 🪙!`,
        `🥀 Проиграл: ${loserName}`,
        ``,
        nextPhrase(chat, 'rpsWin')
      ].join('\n'),
      buildPostGameKeyboard('rps', lobby.stake, false)
    );

    if (winnerP) await applyAutoDebtCollection(transport, chat, winnerP, lobby.stake);
    if (loserP && loserP.balance === 0) await maybeSendZeroBalanceOffer(transport, chat, loserP);
    return;
  }

  await transport.answerCallback(callbackId);
}

// =====================================
// 4. PENALTY ("ПЕНАЛЬТИ — ДУЭЛЬ С ВРАТАРЁМ")
// =====================================

const PENALTY_MULTS = [1.44, 2.16, 3.24, 4.86, 7.29];
const PENALTY_ZONES = ['⬅️ Левый угол', '⬆️ По центру', '➡️ Правый угол'];

interface PenaltySession {
  id: string;
  chatId: string;
  userId: string;
  userName: string;
  stake: number;
  isLastDodep: boolean;
  isAllIn: boolean;
  goals: number; // 0..5
  history: string[];
  status: 'playing' | 'finished';
  createdAt: number;
}

const penaltySessions = new Map<string, PenaltySession>();

function buildPenaltyPayload(chat: ChatState, player: PlayerState, session: PenaltySession): { text: string; keyboard: InlineKeyboard } {
  const curMult = session.goals > 0 ? PENALTY_MULTS[session.goals - 1] : 1.0;
  const nextMult = PENALTY_MULTS[session.goals];
  const curWin = Math.round(session.stake * curMult);

  const lines = [
    `⚽ ПЕНАЛЬТИ — УДАР ${session.goals + 1} ИЗ 5`,
    `👤 Бьющий: ${playerLabel(chat, player)} | Ставка: ${session.stake} 🪙`,
    `🥅 Текущий выигрыш: ${session.goals > 0 ? `${curWin} 🪙 (x${curMult.toFixed(2)})` : '0 🪙'}`,
    `🎯 Следующий гол даст: x${nextMult.toFixed(2)} (${Math.round(session.stake * nextMult)} 🪙)`,
    ``,
    ...(session.history.length > 0 ? [...session.history, ''] : []),
    `Куда бьёшь? (Вратарь закрывает 1 из 3 зон)`
  ];

  const kb: InlineKeyboard = [
    [
      { text: '⬅️ Лево', callbackData: `pn:kick:${session.id}:0` },
      { text: '⬆️ Центр', callbackData: `pn:kick:${session.id}:1` },
      { text: '➡️ Право', callbackData: `pn:kick:${session.id}:2` }
    ]
  ];
  if (session.goals > 0) {
    kb.push([{ text: `💰 Забрать ${curWin} 🪙 (x${curMult.toFixed(2)})`, callbackData: `pn:cash:${session.id}` }]);
  }

  return { text: lines.join('\n'), keyboard: kb };
}

export async function startPenaltyGame(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  stake: number,
  isLastDodep: boolean,
  messageId?: string
): Promise<void> {
  const isAllIn = deductPlayerStake(player, stake);
  scheduleSave();

  const sid = shortId();
  const session: PenaltySession = {
    id: sid,
    chatId: chat.chatId,
    userId: player.userId,
    userName: displayName(player),
    stake,
    isLastDodep,
    isAllIn,
    goals: 0,
    history: [],
    status: 'playing',
    createdAt: Date.now()
  };
  penaltySessions.set(sid, session);
  markRuntimeDirty();

  const view = buildPenaltyPayload(chat, player, session);
  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
  } else {
    await transport.sendMessage(chat.chatId, view.text, view.keyboard);
  }
}

export async function handlePenaltyCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];
  const sid = parts[2];
  const session = penaltySessions.get(sid);

  if (!session || session.status !== 'playing') {
    await transport.answerCallback(callbackId, 'Эта серия пенальти уже завершена!', true);
    return;
  }
  if (session.userId !== player.userId) {
    await transport.answerCallback(callbackId, 'Это серия другого форварда!', true);
    return;
  }

  if (sub === 'cash') {
    if (session.goals <= 0) {
      await transport.answerCallback(callbackId, 'Сначала забей хотя бы 1 гол!', true);
      return;
    }
    session.status = 'finished';
    penaltySessions.delete(sid);

    const mult = PENALTY_MULTS[session.goals - 1];
    const payout = Math.round(session.stake * mult);
    const netProfit = payout - session.stake;

    player.balance += payout;
    player.lastBetAmount = session.stake;
    player.lastGameType = 'penalty';
    player.stats.totalWon += Math.max(0, netProfit);
    if (session.isLastDodep && player.lastActionWasLoss) {
      player.stats.lastDodepWins += 1;
    }
    player.lastActionWasLoss = false;
    player.lastActionWasLastDodep = false;

    if (session.goals >= 2) recordQuestProgress(player, 'skill_streak', 1);
    recordGameOutcome(chat, player, 'penalty', Math.max(0, netProfit), {
      isAllIn: session.isAllIn,
      isLastDodep: session.isLastDodep
    });
    scheduleSave();

    await transport.answerCallback(callbackId, `⚽ Забрал ${payout} 🪙 (x${mult.toFixed(2)})!`);
    await transport.editMessage(
      chat.chatId,
      messageId,
      [
        `⚽ ПЕНАЛЬТИ — КЭШАУТ!`,
        `👤 ${playerLabel(chat, player)} | Забито голов: ${session.goals}/5 (x${mult.toFixed(2)})`,
        `💰 Выигрыш: +${payout} фантиков (чистыми +${netProfit})`,
        `🪙 Баланс: ${player.balance} фантиков`,
        ``,
        nextPhrase(chat, 'penaltyWin')
      ].join('\n'),
      buildPostGameKeyboard('penalty', session.stake, false, player)
    );
    if (netProfit > 0) await applyAutoDebtCollection(transport, chat, player, netProfit);
    return;
  }

  if (sub === 'kick') {
    const kickZone = parseInt(parts[3], 10);
    const keeperZone = Math.floor(Math.random() * 3);

    if (kickZone === keeperZone) {
      // Saved!
      session.status = 'finished';
      penaltySessions.delete(sid);

      player.lastBetAmount = session.stake;
      player.lastGameType = 'penalty';
      player.stats.totalLost += session.stake;
      player.lastActionWasLoss = true;
      player.lastActionWasLastDodep = false;
      recordGameOutcome(chat, player, 'penalty', -session.stake, {
        isAllIn: session.isAllIn,
        isLastDodep: session.isLastDodep
      });
      scheduleSave();

      await transport.answerCallback(callbackId, '🧤 СЕЙВ ВРАТАРЯ!');
      await transport.editMessage(
        chat.chatId,
        messageId,
        [
          `⚽ ПЕНАЛЬТИ — 🧤 СЕЙВ!`,
          `👤 ${playerLabel(chat, player)} | Удар: ${PENALTY_ZONES[kickZone]} | Кипер прыгнул: ${PENALTY_ZONES[keeperZone]}`,
          `🔥 Серия оборвалась на ударе #${session.goals + 1}. Сгорело ${session.stake} 🪙.`,
          `🪙 Баланс: ${player.balance} фантиков`,
          ``,
          nextPhrase(chat, 'penaltyLoss')
        ].join('\n'),
        buildPostGameKeyboard('penalty', session.stake, true, player)
      );
      if (player.balance === 0) await maybeSendZeroBalanceOffer(transport, chat, player);
      return;
    }

    // GOAL!
    session.goals += 1;
    const mult = PENALTY_MULTS[session.goals - 1];
    session.history.push(
      `Удар ${session.goals}: ${PENALTY_ZONES[kickZone]} → ⚽ ГОЛ! (кипер в ${PENALTY_ZONES[keeperZone]}) · x${mult.toFixed(2)}`
    );

    if (session.goals >= 5) {
      session.status = 'finished';
      penaltySessions.delete(sid);
      const payout = Math.round(session.stake * mult);
      const netProfit = payout - session.stake;

      player.balance += payout;
      player.lastBetAmount = session.stake;
      player.lastGameType = 'penalty';
      player.stats.totalWon += netProfit;
      if (session.isLastDodep && player.lastActionWasLoss) {
        player.stats.lastDodepWins += 1;
      }
      player.lastActionWasLoss = false;
      player.lastActionWasLastDodep = false;
      recordQuestProgress(player, 'skill_streak', 1);
      recordGameOutcome(chat, player, 'penalty', netProfit, {
        isAllIn: session.isAllIn,
        isLastDodep: session.isLastDodep
      });
      scheduleSave();

      await transport.answerCallback(callbackId, `🏆 5 из 5! Чистая серия x${mult.toFixed(2)}!`);
      await transport.editMessage(
        chat.chatId,
        messageId,
        [
          `⚽ ПЕНАЛЬТИ — 🏆 ЧИСТАЯ СЕРИЯ 5/5!`,
          `👤 ${playerLabel(chat, player)}`,
          ``,
          ...session.history,
          ``,
          `💰 Максимальный куш (x${mult.toFixed(2)}): +${payout} фантиков!`,
          `🪙 Баланс: ${player.balance} фантиков`,
          ``,
          nextPhrase(chat, 'penaltyWin')
        ].join('\n'),
        buildPostGameKeyboard('penalty', session.stake, false, player)
      );
      if (netProfit > 0) await applyAutoDebtCollection(transport, chat, player, netProfit);
      return;
    }

    await transport.answerCallback(callbackId, `⚽ ГОООЛ! Уже x${mult.toFixed(2)}!`);
    const view = buildPenaltyPayload(chat, player, session);
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    return;
  }

  await transport.answerCallback(callbackId);
}

// =====================================
// 5. PROTECTED MESSAGES & TTL SWEEPER (A3)
// =====================================

export function isNewGamesProtectedMsg(msgId: string): boolean {
  for (const c of crashRounds.values()) if (c.messageId === msgId) return true;
  for (const r of rpsPvpLobbies.values()) if (r.messageId === msgId) return true;
  return false;
}

export async function sweepExpiredNewGames(now = Date.now()): Promise<void> {
  const db = getDb();

  // Sync or expire Crash rounds in serverless mode
  for (const round of Array.from(crashRounds.values())) {
    const chat = db.chats[round.chatId];
    if (!chat) {
      crashRounds.delete(round.id);
      continue;
    }
    if (isServerlessRuntime()) {
      const state = await syncServerlessCrashRound(chat, round);
      if (state === 'finished') continue;
      if (now - round.createdAt >= 8 * 60 * 1000) {
        await finishCrashRound(chat, round, true);
      }
    }
  }

  // Expired waiting PvP RPS lobbies (4 min)
  for (const [sid, lobby] of Array.from(rpsPvpLobbies.entries())) {
    if (lobby.status === 'waiting' && now - lobby.createdAt >= LOBBY_IDLE_TTL_MS) {
      rpsPvpLobbies.delete(sid);
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
        event: 'Таймаут лобби (К-Н-Б)',
        detail: `Ставка ${lobby.stake} 🪙 возвращена ${lobby.creatorName}`
      });
      const tr = getNewGameTransport(lobby.transportSource, lobby.chatId, lobby.transport);
      if (lobby.messageId && tr) {
        await tr.editMessage(
          lobby.chatId,
          lobby.messageId,
          `⏱ Вызов К-Н-Б закрыт по таймауту (4 мин). Ставка ${lobby.stake} 🪙 возвращена создателю.`,
          [[{ text: '🏠 В меню', callbackData: 'menu' }]]
        );
      }
    }
  }

  // Prune abandoned solo sessions older than 20 minutes from RAM
  const SOLO_TTL = 20 * 60 * 1000;
  for (const [id, s] of thimblesSessions.entries()) {
    if (now - s.createdAt >= SOLO_TTL) thimblesSessions.delete(id);
  }
  for (const [id, s] of rpsSoloSessions.entries()) {
    if (now - s.createdAt >= SOLO_TTL) rpsSoloSessions.delete(id);
  }
  for (const [id, s] of penaltySessions.entries()) {
    if (now - s.createdAt >= SOLO_TTL) penaltySessions.delete(id);
  }
}

registerRuntimeAdapter('newGames', {
  exportState: () => ({
    crashRounds: Array.from(crashRounds.values()).map(
      ({ boardingTimer: _bt, flyTimer: _ft, transport: _tr, ...rest }) => ({
        ...rest,
        transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
      })
    ),
    thimblesSessions: Array.from(thimblesSessions.values()),
    rpsSoloSessions: Array.from(rpsSoloSessions.values()),
    rpsPvpLobbies: Array.from(rpsPvpLobbies.values()).map(({ transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
    penaltySessions: Array.from(penaltySessions.values())
  }),
  importState: (raw: any) => {
    for (const r of crashRounds.values()) {
      if (r.boardingTimer) clearTimeout(r.boardingTimer);
      if (r.flyTimer) clearInterval(r.flyTimer);
    }
    crashRounds.clear();
    thimblesSessions.clear();
    rpsSoloSessions.clear();
    rpsPvpLobbies.clear();
    penaltySessions.clear();

    if (Array.isArray(raw?.crashRounds)) {
      for (const r of raw.crashRounds) {
        if (!r?.id || r.status === 'finished') continue;
        crashRounds.set(r.id, {
          ...r,
          entries: Array.isArray(r.entries) ? r.entries : [],
          boardingTimer: null,
          flyTimer: null,
          transport: null
        });
      }
    }
    if (Array.isArray(raw?.thimblesSessions)) {
      for (const s of raw.thimblesSessions) {
        if (s?.id && s.status === 'playing') thimblesSessions.set(s.id, s);
      }
    }
    if (Array.isArray(raw?.rpsSoloSessions)) {
      for (const s of raw.rpsSoloSessions) {
        if (s?.id && s.status === 'playing') rpsSoloSessions.set(s.id, s);
      }
    }
    if (Array.isArray(raw?.rpsPvpLobbies)) {
      for (const l of raw.rpsPvpLobbies) {
        if (l?.id && l.status !== 'finished') {
          rpsPvpLobbies.set(l.id, {
            ...l,
            moves: l.moves || {},
            transport: null
          });
        }
      }
    }
    if (Array.isArray(raw?.penaltySessions)) {
      for (const s of raw.penaltySessions) {
        if (s?.id && s.status === 'playing') {
          penaltySessions.set(s.id, {
            ...s,
            history: Array.isArray(s.history) ? s.history : []
          });
        }
      }
    }
  }
});
