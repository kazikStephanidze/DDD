import {
  BotTransport,
  InlineKeyboard,
  displayName,
  formatDuration,
  getGhostRemainingMs,
  maybeSendZeroBalanceOffer,
  playerLabel
} from '../engineShared.js';
import {
  ChatState,
  PlayerState,
  addBotLog,
  scheduleSave
} from '../storage.js';
import {
  markRuntimeDirty,
  registerRuntimeAdapter
} from '../runtimeRegistry.js';
import {
  recordQuestProgress,
  unlockAchievement
} from '../features/profileQuests.js';

interface PendingBonfireInput {
  chatId: string;
  userId: string;
  messageId: string | null;
  expiresAt: number;
}

const CUSTOM_INPUT_TTL_MS = 2 * 60 * 1000;
const pendingCustomBurnByKey = new Map<string, PendingBonfireInput>();

registerRuntimeAdapter('bonfire', {
  exportState: () => ({
    pending: Array.from(pendingCustomBurnByKey.entries())
      .filter(([, v]) => v && v.expiresAt > Date.now())
      .slice(-100)
  }),
  importState: (raw: any) => {
    pendingCustomBurnByKey.clear();
    if (Array.isArray(raw?.pending)) {
      const now = Date.now();
      for (const entry of raw.pending) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1]?.expiresAt > now) {
          pendingCustomBurnByKey.set(entry[0], entry[1]);
        }
      }
    }
  }
});

const BONFIRE_COMMENTS: string[] = [
  '🔥 Пыхнули купюры — красиво горит! Дядя Деп аж сосиску на твоём кэше поджарил!',
  '💸 Чистый пепел премиум-класса! Инвесторы в воздух аплодируют стоя!',
  '🌋 Дым пошёл столбом! Зачем нужна яхта, когда можно отапливать чат фантиками?',
  '🪵 Бабки улетели в трубу быстрее, чем ракета в Джет Иксе! Уважаемый жест!',
  '🍖 На таких пачках фантиков получился бы царский шашлык на весь чат!',
  '👑 Настоящий богач не считает мелочь — настоящий богач разжигает ей мангал!',
  '🔥 Огонь! Касса Дяди Депа в шоке от такого царского неуважения к деньгам!',
  '🚬 Красиво сгорело дотла — ни выигрыша, ни сдачи, зато понтов на весь месяц!',
  '💰 Пока кто-то копит по сотке в Костях, тут палят капитал просто чтобы было тепло!',
  '☄️ Пепел осел, а слава о главном кочегаре чата осталась навсегда!',
  '🪙 Дядя Деп подкинул твои фантики в камин — температура в чате поднялась на 5 градусов!',
  '😎 Бессмысленно, беспощадно и дико красиво! Вот что значит лишний кэш!',
  '🔥 Ни одна рулетка не сжирает бабки так стильно, как твой собственный костёр!',
  '🐺 Волк не плачет по сгоревшему банку — волк проверяет, не мало ли подбросил!'
];

function fmtCoins(n: number): string {
  return Math.max(0, Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function getBurnChampion(chat: ChatState): { player: PlayerState; amount: number } | null {
  let best: PlayerState | null = null;
  let maxBurned = 0;
  for (const p of Object.values(chat.players)) {
    const b = p.stats.totalBurned || 0;
    if (b > maxBurned) {
      maxBurned = b;
      best = p;
    }
  }
  return best && maxBurned > 0 ? { player: best, amount: maxBurned } : null;
}

export async function openBonfireMenu(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  messageId?: string
): Promise<void> {
  const burned = player.stats.totalBurned || 0;
  const champ = getBurnChampion(chat);
  const champLine = champ
    ? `🔥 Кочегар чата: ${playerLabel(chat, champ.player)} — спалил ${fmtCoins(champ.amount)} 🪙`
    : `🔥 Кочегар чата: спички ещё сухие — стань первым!`;

  const lines = [
    `🔥 КОСТЁР ДЯДИ ДЕПА (СЖЕЧЬ ФАНТИКИ)`,
    `👤 Игрок: ${playerLabel(chat, player)}`,
    `🪙 Твой баланс: ${fmtCoins(player.balance)} 🪙 · Твой вклад в пепел: ${fmtCoins(burned)} 🪙`,
    champLine,
    ``,
    `Бросай в топку любую сумму — деньги сгорают навсегда безвозвратно ради угара, ачивок и особого звания на Доске почёта!`
  ];

  const half = Math.max(1, Math.floor(player.balance / 2));
  const kb: InlineKeyboard = [
    [
      { text: '50 🪙', callbackData: 'bf:burn:50' },
      { text: '100 🪙', callbackData: 'bf:burn:100' },
      { text: '500 🪙', callbackData: 'bf:burn:500' },
      { text: '1 000 🪙', callbackData: 'bf:burn:1000' }
    ],
    [
      { text: '5 000 🪙', callbackData: 'bf:burn:5000' },
      { text: '10 000 🪙', callbackData: 'bf:burn:10000' },
      { text: '50 000 🪙', callbackData: 'bf:burn:50000' },
      { text: '100 000 🪙', callbackData: 'bf:burn:100000' }
    ]
  ];

  if (player.balance > 0) {
    kb.push([
      { text: `🔥 Половину (${fmtCoins(half)} 🪙)`, callbackData: 'bf:burn:half' },
      { text: `💥 Всё до пепла (${fmtCoins(player.balance)} 🪙)`, callbackData: 'bf:burn:all' }
    ]);
  }

  kb.push([{ text: '✍️ Вписать свою сумму числом', callbackData: 'bf:custom' }]);
  kb.push([
    { text: '🏆 Доска почёта', callbackData: 'top' },
    { text: '↩️ В меню', callbackData: 'menu' }
  ]);

  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, lines.join('\n'), kb);
  } else {
    await transport.sendMessage(chat.chatId, lines.join('\n'), kb);
  }
}

export async function executeBonfireBurn(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  amount: number,
  messageId?: string | null,
  callbackId?: string
): Promise<void> {
  const ghostMs = getGhostRemainingMs(player);
  if (ghostMs > 0) {
    const msg = `👻 Ты Призрак чата ещё ${formatDuration(ghostMs)}! Остынь немного.`;
    if (callbackId) await transport.answerCallback(callbackId, msg, true);
    else await transport.sendMessage(chat.chatId, msg);
    return;
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    if (callbackId) await transport.answerCallback(callbackId, 'Укажи сумму от 1 фантика!', true);
    return;
  }

  if (player.balance < amount) {
    const msg = `🪙 У тебя только ${fmtCoins(player.balance)} 🪙 — столько спалить не выйдет!`;
    if (callbackId) await transport.answerCallback(callbackId, msg, true);
    else await transport.sendMessage(chat.chatId, msg);
    return;
  }

  player.balance -= amount;
  player.stats.totalBurned = (player.stats.totalBurned || 0) + amount;
  player.stats.gamesPlayed = (player.stats.gamesPlayed || 0) + 1;
  if (!player.stats.gameCounts) player.stats.gameCounts = {};
  player.stats.gameCounts['bonfire'] = (player.stats.gameCounts['bonfire'] || 0) + 1;
  player.lastBetAmount = amount;
  player.lastGameType = 'bonfire';
  if (amount >= 50) {
    recordQuestProgress(player, 'play_any', 1);
  }

  const totalBurned = player.stats.totalBurned;
  if (totalBurned >= 5_000) unlockAchievement(chat, player, 'pyromaniac');
  if (totalBurned >= 50_000) unlockAchievement(chat, player, 'mega_pyro');
  scheduleSave();

  const comment = BONFIRE_COMMENTS[Math.floor(Math.random() * BONFIRE_COMMENTS.length)];
  const champ = getBurnChampion(chat);
  const isChamp = champ && champ.player.userId === player.userId;

  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: `Костёр Дяди Депа: -${fmtCoins(amount)} 🪙`,
    detail: `Всего сожжено этим игроком: ${fmtCoins(totalBurned)} 🪙`
  });

  if (callbackId) {
    await transport.answerCallback(callbackId, `🔥 Сожжено ${fmtCoins(amount)} 🪙 в пепел!`);
  }

  const lines = [
    `🔥🔥 ПЛАМЯ ПОШЛО! ФАНТИКИ В ПЕПЕЛ!`,
    `👤 Поджигатель: ${playerLabel(chat, player)}`,
    `💥 Спалил в эту секунду: ${fmtCoins(amount)} 🪙`,
    `🌋 Всего спалено за всё время: ${fmtCoins(totalBurned)} 🪙${isChamp ? ' 👑 (ЛИДЕР ЧАТА!)' : ''}`,
    `🪙 Остаток на руках: ${fmtCoins(player.balance)} 🪙`,
    ``,
    comment
  ];

  const kb: InlineKeyboard =
    player.balance > 0
      ? [
          [
            { text: `🔥 Подкинуть ещё (${fmtCoins(Math.min(amount, player.balance))} 🪙)`, callbackData: `bf:burn:${Math.min(amount, player.balance)}` },
            { text: '✍️ Другую сумму', callbackData: 'bf:menu' }
          ],
          [
            { text: '🏆 Доска почёта', callbackData: 'top' },
            { text: '🏠 В меню', callbackData: 'menu' }
          ]
        ]
      : [
          [
            { text: '🏆 Доска почёта', callbackData: 'top' },
            { text: '🏠 В меню', callbackData: 'menu' }
          ]
        ];

  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, lines.join('\n'), kb);
  } else {
    await transport.sendMessage(chat.chatId, lines.join('\n'), kb);
  }

  if (player.balance === 0) {
    await maybeSendZeroBalanceOffer(transport, chat, player);
  }
}

export async function handleBonfireCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1] || 'menu';
  const key = `${chat.chatId}:${player.userId}`;

  if (sub === 'menu') {
    pendingCustomBurnByKey.delete(key);
    markRuntimeDirty();
    await transport.answerCallback(callbackId);
    await openBonfireMenu(transport, chat, player, messageId);
    return;
  }

  if (sub === 'custom') {
    if (player.balance <= 0) {
      await transport.answerCallback(callbackId, 'У тебя 0 🪙 — сжигать пока нечего!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }

    pendingCustomBurnByKey.set(key, {
      chatId: chat.chatId,
      userId: player.userId,
      messageId: messageId || null,
      expiresAt: Date.now() + CUSTOM_INPUT_TTL_MS
    });
    markRuntimeDirty();

    await transport.answerCallback(callbackId, 'Напиши число в чат!');
    const promptText = [
      `✍️ СЖЕЧЬ ТОЧНУЮ СУММУ`,
      `👤 ${playerLabel(chat, player)} · Баланс: ${fmtCoins(player.balance)} 🪙`,
      ``,
      `Отправь в чат просто число (от 1 до ${fmtCoins(player.balance)}) — и Дядя Деп мгновенно сожжёт эту сумму в костре!`,
      `_(Ожидание активно 2 минуты)_`
    ].join('\n');
    const kb: InlineKeyboard = [
      [{ text: '↩️ Отмена (назад к кнопкам)', callbackData: 'bf:menu' }]
    ];
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, promptText, kb);
    } else {
      const sentId = await transport.sendMessage(chat.chatId, promptText, kb);
      const pending = pendingCustomBurnByKey.get(key);
      if (pending && sentId) {
        pending.messageId = sentId;
        markRuntimeDirty();
      }
    }
    return;
  }

  if (sub === 'burn') {
    pendingCustomBurnByKey.delete(key);
    markRuntimeDirty();
    const raw = parts[2] || '0';
    let amount = 0;
    if (raw === 'all') {
      amount = player.balance;
    } else if (raw === 'half') {
      amount = Math.max(1, Math.floor(player.balance / 2));
    } else {
      amount = parseInt(raw, 10);
    }
    await executeBonfireBurn(transport, chat, player, amount, messageId, callbackId);
    return;
  }

  await transport.answerCallback(callbackId);
}

export async function tryHandleBonfireTextInput(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  text: string
): Promise<boolean> {
  const key = `${chat.chatId}:${player.userId}`;
  const pending = pendingCustomBurnByKey.get(key);
  if (!pending) return false;
  if (Date.now() > pending.expiresAt) {
    pendingCustomBurnByKey.delete(key);
    markRuntimeDirty();
    return false;
  }

  const cleaned = text.replace(/\s+/g, '');
  if (!/^\d+$/.test(cleaned)) {
    return false;
  }

  const amount = parseInt(cleaned, 10);
  pendingCustomBurnByKey.delete(key);
  markRuntimeDirty();

  if (!Number.isFinite(amount) || amount <= 0 || amount > player.balance) {
    await transport.sendMessage(
      chat.chatId,
      `⚠️ ${playerLabel(chat, player)}, нужно число от 1 до ${fmtCoins(player.balance)} 🪙! Нажми «🔥 Костёр» заново.`,
      [[{ text: '🔥 Открыть Костёр', callbackData: 'bf:menu' }]]
    );
    return true;
  }

  await executeBonfireBurn(transport, chat, player, amount, null);
  return true;
}
