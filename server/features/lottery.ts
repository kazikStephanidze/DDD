import {
  BotTransport,
  InlineKeyboard,
  applyAutoDebtCollection,
  displayName,
  getGhostRemainingMs,
  formatDuration,
  getTodayDateStr,
  nextPhrase,
  playerLabel
} from '../engineShared.js';
import {
  ChatState,
  LOTTERY_TICKET_PRICE,
  LotteryTicket,
  PlayerState,
  addBotLog,
  getDb,
  scheduleSave
} from '../storage.js';
import { recordQuestProgress, unlockAchievement } from './profileQuests.js';

function ensureTodayLottery(chat: ChatState, today = getTodayDateStr()) {
  if (!chat.lottery || chat.lottery.date !== today) {
    chat.lottery = {
      date: today,
      tickets: [],
      lastDrawnDate: chat.lottery?.lastDrawnDate || ''
    };
  }
  return chat.lottery;
}

export function buildLotteryView(chat: ChatState, player: PlayerState): { text: string; keyboard: InlineKeyboard } {
  const lot = ensureTodayLottery(chat);
  const totalTickets = lot.tickets.length;
  const pot = totalTickets * LOTTERY_TICKET_PRICE;

  const byUser = new Map<string, { name: string; count: number }>();
  for (const t of lot.tickets) {
    const p = chat.players[t.userId];
    const name = p ? playerLabel(chat, p) : t.firstName;
    const cur = byUser.get(t.userId) || { name, count: 0 };
    cur.count += 1;
    byUser.set(t.userId, cur);
  }

  const myTickets = lot.tickets.filter((t) => t.userId === player.userId);
  const myPct = totalTickets > 0 ? ((myTickets.length / totalTickets) * 100).toFixed(1) : '0.0';

  const lines = [
    `🎟️ ВЕЧЕРНЯЯ ЛОТЕРЕЯ «ОБЩАК ДНЯ»`,
    `👤 ${playerLabel(chat, player)} | Баланс: ${player.balance} 🪙`,
    ``,
    `💰 Накопленный банк дня: ${pot} 🪙 (${totalTickets} билетов)`,
    `🎫 Цена 1 билета: ${LOTTERY_TICKET_PRICE} 🪙`,
    `⏰ Розыгрыш каждый день ровно в 20:55 (перед вечерней сводкой):`,
    `   🥇 1 место — 70% | 🥈 2 место — 20% | 🥉 3 место — 10%`,
    ``,
    `Твоих билетов: ${myTickets.length} шт. (шанс билета: ${myPct}%)`
  ];

  if (byUser.size > 0) {
    lines.push(``, `👥 Участники сегодняшнего тиража:`);
    const sorted = [...byUser.values()].sort((a, b) => b.count - a.count).slice(0, 8);
    for (const u of sorted) {
      lines.push(`• ${u.name} — ${u.count} бил. (${u.count * LOTTERY_TICKET_PRICE} 🪙)`);
    }
  } else {
    lines.push(``, `Пока никто не взял билет — стань первым в сегодняшнем тираже!`);
  }

  const kb: InlineKeyboard = [
    [
      { text: `🎫 1 билет (${LOTTERY_TICKET_PRICE} 🪙)`, callbackData: 'lot:buy:1' },
      { text: `🎫 3 билета (${LOTTERY_TICKET_PRICE * 3} 🪙)`, callbackData: 'lot:buy:3' }
    ],
    [{ text: `🔥 5 билетов (${LOTTERY_TICKET_PRICE * 5} 🪙)`, callbackData: 'lot:buy:5' }],
    [
      { text: '🔄 Обновить', callbackData: 'lot:menu' },
      { text: '🏠 В меню', callbackData: 'menu' }
    ]
  ];

  return { text: lines.join('\n'), keyboard: kb };
}

export async function handleLotteryCallback(
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
    const view = buildLotteryView(chat, player);
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    } else {
      await transport.sendMessage(chat.chatId, view.text, view.keyboard);
    }
    return;
  }

  if (sub === 'buy') {
    const qty = Math.max(1, Math.min(10, parseInt(parts[2] || '1', 10) || 1));
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Ты Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }

    const cost = qty * LOTTERY_TICKET_PRICE;
    if (player.balance < cost) {
      await transport.answerCallback(
        callbackId,
        `Не хватает фантиков! Нужно ${cost} 🪙, у тебя ${player.balance} 🪙.`,
        true
      );
      return;
    }

    const lot = ensureTodayLottery(chat);
    player.balance -= cost;
    const startNum = lot.tickets.length + 1;
    const nums: number[] = [];
    for (let i = 0; i < qty; i++) {
      const ticketNum = startNum + i;
      lot.tickets.push({
        userId: player.userId,
        firstName: displayName(player),
        ticketNum,
        boughtAt: Date.now()
      });
      nums.push(ticketNum);
    }

    recordQuestProgress(player, 'social_pot_lot', 1);
    scheduleSave();

    await transport.answerCallback(callbackId, `🎫 Куплено билетов: ${qty} (#${nums.join(', #')})`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: `Лотерея: куплено ${qty} бил.`,
      detail: `Билеты #${nums.join(', #')} (${cost} 🪙)`
    });

    const view = buildLotteryView(chat, player);
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    return;
  }

  await transport.answerCallback(callbackId);
}

export async function sendDailyLotteryDrawBroadcast(
  transport: BotTransport,
  chatId: string,
  forceDate?: string
): Promise<boolean> {
  const db = getDb();
  const chat = db.chats[chatId];
  if (!chat) return false;

  const dateStr = forceDate || getTodayDateStr();
  const todayStr = getTodayDateStr();
  const lot = chat.lottery;
  if (!lot || lot.tickets.length === 0) {
    if (!chat.lottery) chat.lottery = { date: dateStr, tickets: [], lastDrawnDate: dateStr };
    else {
      chat.lottery.date = dateStr;
      chat.lottery.lastDrawnDate = dateStr;
    }
    scheduleSave();

    const hasPlayers = Object.keys(chat.players).length > 0;
    const isPastEmptyDay = Boolean(forceDate && forceDate < todayStr);
    if (!hasPlayers || isPastEmptyDay) {
      return false;
    }

    addBotLog({
      source: 'scheduler',
      chatId: chat.chatId,
      chatTitle: chat.title,
      event: 'Лотерея 20:55 (Пустой тираж)',
      detail: 'Никто не купил билеты — тираж не состоялся'
    });
    await transport.sendMessage(
      chat.chatId,
      [
        `🎟️ ВЕЧЕРНЯЯ ЛОТЕРЕЯ «ОБЩАК ДНЯ» (20:55)`,
        ``,
        `Сегодня никто в чате не взял ни одного билета по ${LOTTERY_TICKET_PRICE} 🪙 — барабан крутить не из чего!`,
        `💨 Дневной банк остался пустым. Залетайте в завтрашний тираж заранее (🥇 70% / 🥈 20% / 🥉 10%)!`
      ].join('\n'),
      [
        [{ text: `🎟️ Взять билет на завтра (${LOTTERY_TICKET_PRICE} 🪙)`, callbackData: 'lot:menu' }],
        [{ text: '🏠 В меню', callbackData: 'menu' }]
      ]
    );
    return true;
  }

  const tickets = [...lot.tickets];
  const pot = tickets.length * LOTTERY_TICKET_PRICE;
  const distinctUsers = new Set(tickets.map((t) => t.userId));

  lot.lastDrawnDate = dateStr;
  lot.tickets = [];
  lot.date = dateStr;

  // If only 1 player bought tickets, refund cleanly so nobody farms solo wins
  if (distinctUsers.size === 1) {
    const onlyUserId = tickets[0].userId;
    const p = chat.players[onlyUserId];
    if (p) {
      p.balance += pot;
    }
    scheduleSave();
    addBotLog({
      source: 'scheduler',
      chatId: chat.chatId,
      chatTitle: chat.title,
      event: 'Лотерея 20:55 (Возврат)',
      detail: `Участвовал только 1 игрок — банк ${pot} 🪙 возвращён`
    });
    await transport.sendMessage(
      chat.chatId,
      [
        `🎟️ РОЗЫГРЫШ ЛОТЕРЕИ «ОБЩАК ДНЯ» (20:55)`,
        ``,
        `В сегодняшнем тираже билеты взял только ${p ? playerLabel(chat, p) : tickets[0].firstName}.`,
        `🪙 Весь банк (${pot} 🪙) возвращён единственному участнику — завтра зовите в тираж больше пацанов!`
      ].join('\n'),
      [[{ text: '🎟️ Взять билет на завтра', callbackData: 'lot:menu' }]]
    );
    return true;
  }

  // Draw up to 3 winning tickets (preferring distinct winners if possible)
  const winners: { ticket: LotteryTicket; prize: number; place: number }[] = [];
  const remainingTickets = [...tickets];
  const usedUserIds = new Set<string>();

  const pickWinnerTicket = (): LotteryTicket | null => {
    if (remainingTickets.length === 0) return null;
    const unpickedUserPool = remainingTickets.filter((t) => !usedUserIds.has(t.userId));
    const pool = unpickedUserPool.length > 0 ? unpickedUserPool : remainingTickets;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const rmIdx = remainingTickets.findIndex((t) => t.ticketNum === chosen.ticketNum);
    if (rmIdx !== -1) remainingTickets.splice(rmIdx, 1);
    usedUserIds.add(chosen.userId);
    return chosen;
  };

  const shares = distinctUsers.size >= 3 && tickets.length >= 3 ? [0.7, 0.2, 0.1] : [0.75, 0.25];
  let distributed = 0;

  shares.forEach((ratio, idx) => {
    const tk = pickWinnerTicket();
    if (!tk) return;
    const isLast = idx === shares.length - 1;
    const prize = isLast ? Math.max(1, pot - distributed) : Math.max(1, Math.round(pot * ratio));
    distributed += prize;
    winners.push({ ticket: tk, prize, place: idx + 1 });
  });

  const resultLines: string[] = [];
  const autoCollectQueue: { player: PlayerState; net: number }[] = [];
  const medals = ['🥇', '🥈', '🥉'];

  for (const w of winners) {
    const p = chat.players[w.ticket.userId];
    if (p) {
      p.balance += w.prize;
      p.stats.totalWon += w.prize;
      p.stats.winsCount = (p.stats.winsCount || 0) + 1;
      if (w.prize > (p.stats.biggestWin || 0)) {
        p.stats.biggestWin = w.prize;
      }
      recordQuestProgress(p, 'win_any', 1);
      if (p.balance >= 5000) unlockAchievement(chat, p, 'oligarch_5k');
      autoCollectQueue.push({ player: p, net: w.prize });
    }
    const name = p ? playerLabel(chat, p) : w.ticket.firstName;
    resultLines.push(`${medals[w.place - 1] || '🏅'} ${w.place} место — Билет #${w.ticket.ticketNum} (${name}): +${w.prize} 🪙`);
  }

  scheduleSave();

  addBotLog({
    source: 'scheduler',
    chatId: chat.chatId,
    chatTitle: chat.title,
    event: 'Лотерея 20:55 (Розыгрыш)',
    detail: `Банк ${pot} 🪙 (${tickets.length} бил.) разыгран между ${winners.length} призёрами`
  });

  await transport.sendMessage(
    chat.chatId,
    [
      `🎟️ ИТОГИ ВЕЧЕРНЕЙ ЛОТЕРЕИ «ОБЩАК ДНЯ» (20:55)`,
      `💰 Разыгранный банк: ${pot} 🪙 (${tickets.length} билетов · ${distinctUsers.size} участников)`,
      ``,
      ...resultLines,
      ``,
      nextPhrase(chat, 'lotteryWin')
    ].join('\n'),
    [
      [
        { text: '🎟️ Взять билет на завтра', callbackData: 'lot:menu' },
        { text: '🏠 В меню', callbackData: 'menu' }
      ]
    ]
  );

  for (const item of autoCollectQueue) {
    await applyAutoDebtCollection(transport, chat, item.player, item.net);
  }
  return true;
}
