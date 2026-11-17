import {
  BotTransport,
  GAME_TITLES,
  InlineKeyboard,
  displayName,
  getActiveLoansForBorrower,
  getActiveLoansForLender,
  getRemainingDebt,
  getTodayDateStr,
  nextPhrase,
  playerLabel,
  shortId
} from '../engineShared.js';
import {
  ChatState,
  DAILY_QUEST_REWARD_COINS,
  DailyQuestItem,
  DailyQuestKind,
  GameType,
  OwnedTalisman,
  PlayerDailyQuests,
  PlayerState,
  addBotLog,
  scheduleSave
} from '../storage.js';
import {
  CASE_BY_ID,
  RARITY_META,
  TALISMAN_BY_ID,
  TalismanDef,
  UNIQUE_TALISMANS,
  getTalismansByRarity,
  rollRarityForCase
} from '../talismans.js';
import {
  formatHourlyRate,
  getTalismanIncomeSnapshot,
  syncTalismanPassiveIncome
} from './talismanIncome.js';

export interface AchievementDef {
  id: string;
  emoji: string;
  title: string;
  desc: string;
}

export const ACHIEVEMENTS_CATALOG: AchievementDef[] = [
  { id: 'first_blood', emoji: '🎲', title: 'Первый деп', desc: 'Сыграть хотя бы 1 игру' },
  { id: 'survivor', emoji: '🔫', title: 'Везучий ствол', desc: 'Выжить в Русской рулетке' },
  { id: 'ghost_walker', emoji: '👻', title: 'Гость того света', desc: 'Поймать пулю в Русской рулетке' },
  { id: 'zero_sniper', emoji: '🟢', title: 'Снайпер Зеро', desc: 'Поймать Зеро x14 в Рулетке' },
  { id: 'jackpot_777', emoji: '🎰', title: 'Король 777', desc: 'Выбить тройку в Слоте 777' },
  { id: 'astronaut', emoji: '🚀', title: 'Космонавт', desc: 'Забрать в Краше x5.00 или выше' },
  { id: 'dodep_king', emoji: '🔥', title: 'Мастер камбэка', desc: 'Выиграть Ласт додепом (x2)' },
  { id: 'alchemist', emoji: '⚗️', title: 'Алхимик общака', desc: 'Скрафтить талисман (контракт 3→1)' },
  { id: 'collector_unique', emoji: '🔴', title: 'Хранитель реликвии', desc: 'Получить Уникальный талисман (1/1)' },
  { id: 'philanthropist', emoji: '🤝', title: 'Кредитор чата', desc: 'Выдать P2P-займ участнику чата' },
  { id: 'oligarch_5k', emoji: '👑', title: 'Авторитет стола', desc: 'Накопить 5 000+ фантиков на балансе' },
  { id: 'title_collector', emoji: '🏷️', title: 'Человек с понтами', desc: 'Купить дорогой титул или пранк-прозвище' },
  { id: 'pyromaniac', emoji: '🔥', title: 'Кочегар пустоты', desc: 'Сжечь в Костре Дяди Депа от 5 000 🪙 суммарно' },
  { id: 'mega_pyro', emoji: '🌋', title: 'Миллионер-поджигатель', desc: 'Сжечь в Костре Дяди Депа от 50 000 🪙 суммарно' }
];

export const ACHIEVEMENT_BY_ID: Record<string, AchievementDef> = Object.fromEntries(
  ACHIEVEMENTS_CATALOG.map((a) => [a.id, a])
);

export function unlockAchievement(chat: ChatState, player: PlayerState, id: string): boolean {
  if (!ACHIEVEMENT_BY_ID[id]) return false;
  if (!player.achievements) player.achievements = [];
  if (player.achievements.includes(id)) return false;
  player.achievements.push(id);
  scheduleSave();

  const def = ACHIEVEMENT_BY_ID[id];
  addBotLog({
    source: 'scheduler',
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: `Ачивка: ${def.emoji} ${def.title}`,
    detail: def.desc
  });
  return true;
}

const QUEST_TEMPLATES: { id: DailyQuestKind; title: string; target: number }[] = [
  { id: 'play_any', title: 'Сыграть 5 любых игр за столом', target: 5 },
  { id: 'win_any', title: 'Одержать 2 чистые победы в играх', target: 2 },
  { id: 'crash_x2', title: 'Забрать в Краше на x2.00 или выше', target: 1 },
  { id: 'allin_or_dodep', title: 'Зарядить Ва-банк или Ласт додеп (x2)', target: 1 },
  { id: 'case_or_craft', title: 'Открыть кейс или скрафтить талисман', target: 1 },
  { id: 'table_games', title: 'Сыграть 2 раза в Кости или Блэкджек', target: 2 },
  { id: 'skill_streak', title: 'Пройти 3+ этажа в Лесенке или забить 2+ в Пенальти', target: 1 },
  { id: 'social_pot_lot', title: 'Купить билет Лотереи или войти в Котёл', target: 1 }
];

export function ensureDailyQuests(player: PlayerState): PlayerDailyQuests {
  const today = getTodayDateStr();
  if (player.dailyQuests && player.dailyQuests.date === today && player.dailyQuests.quests.length === 3) {
    return player.dailyQuests;
  }

  // Pick 3 distinct quests for today (always include 1 core play/win + 2 varied)
  const shuffled = [...QUEST_TEMPLATES].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, 3).map<DailyQuestItem>((t) => ({
    id: t.id,
    title: t.title,
    progress: 0,
    target: t.target,
    done: false
  }));

  player.dailyQuests = {
    date: today,
    quests: picked,
    rewardClaimed: false
  };
  scheduleSave();
  return player.dailyQuests;
}

export function recordQuestProgress(player: PlayerState, kind: DailyQuestKind, amount = 1): void {
  const dq = ensureDailyQuests(player);
  let changed = false;
  for (const q of dq.quests) {
    if (q.id === kind && !q.done) {
      q.progress = Math.min(q.target, q.progress + amount);
      if (q.progress >= q.target) {
        q.done = true;
      }
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

export function recordGameOutcome(
  chat: ChatState,
  player: PlayerState,
  game: GameType,
  netProfit: number,
  opts?: { isAllIn?: boolean; isLastDodep?: boolean }
): void {
  if (!player.stats.gameCounts) player.stats.gameCounts = {};
  player.stats.gameCounts[game] = (player.stats.gameCounts[game] || 0) + 1;

  if (netProfit > 0) {
    player.stats.winsCount = (player.stats.winsCount || 0) + 1;
    if (netProfit > (player.stats.biggestWin || 0)) {
      player.stats.biggestWin = netProfit;
    }
    recordQuestProgress(player, 'win_any', 1);
  }

  recordQuestProgress(player, 'play_any', 1);
  if (game === 'dice' || game === 'blackjack' || game === 'bjtable') {
    recordQuestProgress(player, 'table_games', 1);
  }
  if (opts?.isAllIn || opts?.isLastDodep) {
    recordQuestProgress(player, 'allin_or_dodep', 1);
  }

  // Achievements
  if (player.stats.gamesPlayed >= 1) unlockAchievement(chat, player, 'first_blood');
  if (player.balance >= 5000) unlockAchievement(chat, player, 'oligarch_5k');
  if (opts?.isLastDodep && netProfit > 0) unlockAchievement(chat, player, 'dodep_king');
  if ((player.talismans || []).some((t) => TALISMAN_BY_ID[t.talismanId]?.rarity === 'unique')) {
    unlockAchievement(chat, player, 'collector_unique');
  }
  scheduleSave();
}

export function buildDailyQuestsView(chat: ChatState, player: PlayerState): { text: string; keyboard: InlineKeyboard } {
  const dq = ensureDailyQuests(player);
  const doneCount = dq.quests.filter((q) => q.done).length;
  const allDone = doneCount === dq.quests.length;

  const lines = [
    `📋 ЕЖЕДНЕВНЫЕ ЗАДАНИЯ («ДЕЙЛИКИ»)`,
    `👤 ${playerLabel(chat, player)} | Дата: ${dq.date}`,
    ``,
    `Выполни все 3 задания за сутки и забери на выбор +${DAILY_QUEST_REWARD_COINS} 🪙 или бесплатный кейс «Бомж-пакет»!`,
    ``
  ];

  dq.quests.forEach((q, idx) => {
    const mark = q.done ? '✅' : '⏳';
    lines.push(`${idx + 1}. ${mark} ${q.title} [${q.progress}/${q.target}]`);
  });

  lines.push(``);
  if (dq.rewardClaimed) {
    lines.push(`🎁 Награда за сегодня уже получена! Новые задания появятся завтра.`);
  } else if (allDone) {
    lines.push(`🔥 Все 3 задания закрыты! Выбирай награду кнопкой ниже:`);
  } else {
    lines.push(`Прогресс: ${doneCount}/3. Осталось совсем чуть-чуть!`);
  }

  const kb: InlineKeyboard = [];
  if (allDone && !dq.rewardClaimed) {
    kb.push([
      { text: `💰 Забрать +${DAILY_QUEST_REWARD_COINS} 🪙`, callbackData: 'dq:claim:coins' },
      { text: `📦 Кейс «Бомж-пакет»`, callbackData: 'dq:claim:case' }
    ]);
  }
  kb.push([
    { text: '🪪 Мой профиль', callbackData: 'me:view' },
    { text: '🏠 В меню', callbackData: 'menu' }
  ]);

  return { text: lines.join('\n'), keyboard: kb };
}

export async function handleDailyQuestsCallback(
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
    const view = buildDailyQuestsView(chat, player);
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    } else {
      await transport.sendMessage(chat.chatId, view.text, view.keyboard);
    }
    return;
  }

  if (sub === 'claim') {
    const mode = parts[2] === 'case' ? 'case' : 'coins';
    const dq = ensureDailyQuests(player);
    if (dq.rewardClaimed) {
      await transport.answerCallback(callbackId, 'Награда за сегодня уже получена!', true);
      return;
    }
    if (!dq.quests.every((q) => q.done)) {
      await transport.answerCallback(callbackId, 'Сначала закрой все 3 задания!', true);
      return;
    }

    dq.rewardClaimed = true;
    const phrase = nextPhrase(chat, 'dailyQuestDone');

    if (mode === 'coins') {
      player.balance += DAILY_QUEST_REWARD_COINS;
      if (player.balance >= 5000) unlockAchievement(chat, player, 'oligarch_5k');
      scheduleSave();

      await transport.answerCallback(callbackId, `+${DAILY_QUEST_REWARD_COINS} 🪙 за дейлики!`);
      addBotLog({
        source: transport.source,
        chatId: chat.chatId,
        chatTitle: chat.title,
        userName: displayName(player),
        event: 'Дейлики: награда +300 🪙',
        detail: `Выполнено 3/3 заданий за ${dq.date}`
      });

      const view = buildDailyQuestsView(chat, player);
      await transport.editMessage(
        chat.chatId,
        messageId,
        `${view.text}\n\n🪙 Баланс: ${player.balance} фантиков\n${phrase}`,
        view.keyboard
      );
      return;
    }

    // Free Bomzh case drop
    const caseDef = CASE_BY_ID['bomzh'];
    const rolledRarity = rollRarityForCase(caseDef);
    const pool = getTalismansByRarity(rolledRarity === 'unique' ? 'legendary' : rolledRarity);
    const dropped: TalismanDef = pool[Math.floor(Math.random() * pool.length)];
    const inst: OwnedTalisman = {
      instanceId: shortId(),
      talismanId: dropped.id,
      obtainedAt: Date.now()
    };
    const beforeSnap = syncTalismanPassiveIncome(player);
    const hadSpeciesBefore = (player.talismans || []).some((t) => t.talismanId === dropped.id);
    if (!player.talismans) player.talismans = [];
    player.talismans.push(inst);
    player.stats.casesOpened = (player.stats.casesOpened || 0) + 1;
    const afterSnap = getTalismanIncomeSnapshot(player);
    const rateDelta = Math.round((afterSnap.hourlyRate - beforeSnap.hourlyRate) * 100) / 100;
    scheduleSave();

    const meta = RARITY_META[dropped.rarity];
    await transport.answerCallback(callbackId, `📦 Выпал ${dropped.emoji} ${dropped.name}!`);
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'Дейлики: бесплатный Бомж-пакет',
      detail: `Выпал ${meta.badge} ${dropped.emoji} ${dropped.name}`
    });

    const deltaStr =
      rateDelta > 0
        ? ` (+${formatHourlyRate(rateDelta)} 🪙/ч${!hadSpeciesBefore ? ' · 🆕 новый вид!' : ''})`
        : '';

    await transport.editMessage(
      chat.chatId,
      messageId,
      [
        `📦 БЕСПЛАТНЫЙ «БОМЖ-ПАКЕТ» ЗА ДЕЙЛИКИ!`,
        `👤 ${playerLabel(chat, player)}`,
        ``,
        `🎁 Выпал талисман: ${meta.badge} ${dropped.emoji} ${dropped.name}${!hadSpeciesBefore ? ' 🆕' : ''} (${meta.label})`,
        `📜 «${dropped.lore}»`,
        `🏦 Доход шкатулки: +${formatHourlyRate(afterSnap.hourlyRate)} 🪙/ч${deltaStr}`,
        `♻️ Переработка: ${dropped.recycleValue} 🪙`,
        ``,
        phrase
      ].join('\n'),
      [
        [
          { text: '🎒 Моя шкатулка', callbackData: 'tl:bag:0' },
          { text: '📋 К дейликам', callbackData: 'dq:menu' }
        ],
        [{ text: '🏠 В меню', callbackData: 'menu' }]
      ]
    );
    return;
  }

  await transport.answerCallback(callbackId);
}

export function buildProfileView(chat: ChatState, player: PlayerState): { text: string; keyboard: InlineKeyboard } {
  const dq = ensureDailyQuests(player);
  const dqDone = dq.quests.filter((q) => q.done).length;
  const games = player.stats.gamesPlayed || 0;
  const wins = player.stats.winsCount || 0;
  const winrate = games > 0 ? `${Math.round((wins / games) * 100)}%` : '0%';
  const netProfit = (player.stats.totalWon || 0) - (player.stats.totalLost || 0);
  const netStr = netProfit >= 0 ? `+${netProfit}` : `${netProfit}`;

  // Favorite game
  const counts = player.stats.gameCounts || {};
  let favGameStr = 'пока не выбрана';
  const topEntry = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (topEntry) {
    const title = GAME_TITLES[topEntry[0] as GameType] || topEntry[0];
    favGameStr = `${title} (${topEntry[1]} раз)`;
  }

  // Loans
  const owed = getActiveLoansForBorrower(chat, player.userId).reduce((s, l) => s + getRemainingDebt(l), 0);
  const lent = getActiveLoansForLender(chat, player.userId).reduce((s, l) => s + getRemainingDebt(l), 0);

  // Talismans
  const tals = player.talismans || [];
  const uniqs = tals.filter((t) => TALISMAN_BY_ID[t.talismanId]?.rarity === 'unique');
  const eqDef =
    player.equippedTalismanId && tals.some((t) => t.talismanId === player.equippedTalismanId)
      ? TALISMAN_BY_ID[player.equippedTalismanId]
      : null;
  const incomeSnap = getTalismanIncomeSnapshot(player);

  // Achievements
  const unlockedIds = new Set(player.achievements || []);
  const unlockedDefs = ACHIEVEMENTS_CATALOG.filter((a) => unlockedIds.has(a.id));
  const unlockedBadges = unlockedDefs
    .map((a) => `${a.emoji} ${a.title}`)
    .join(', ');

  const burned = player.stats.totalBurned || 0;

  const lines = [
    `🪪 ЛИЧНОЕ ДЕЛО ИГРОКА`,
    `👤 ${playerLabel(chat, player)} · Чат «${chat.title}»`,
    ``,
    `🪙 Баланс: ${player.balance} фантиков`,
    `📊 Игр сыграно: ${games} | Побед: ${wins} (Винрейт: ${winrate})`,
    `📈 Общий профит: ${netStr} 🪙 (Поднято: +${player.stats.totalWon} / Слито: -${player.stats.totalLost})`,
    `🏆 Лучший занос: +${player.stats.biggestWin || 0} 🪙 | Рекорд Краша: x${player.stats.maxCrashMultiplier.toFixed(2)}`,
    `🔥 Сожжено в костре Дяди Депа: ${burned} 🪙`,
    `🎮 Любимая игра: ${favGameStr}`,
    `♻️ Ласт-додепов (x2) затащено: ${player.stats.lastDodepWins || 0} | Ва-банков: ${player.stats.allInCount || 0}`,
    ``,
    `🤝 Долги: должен ${owed} 🪙 | выдано кентам ${lent} 🪙`,
    `🎒 Талисманы: ${tals.length} шт. (Уников 1/1: ${uniqs.length}) · Значок: ${eqDef ? `${eqDef.emoji} ${eqDef.name}` : 'нет'}`,
    `🏦 Доход от талисманов: +${formatHourlyRate(incomeSnap.hourlyRate)} 🪙/ч · накоплено ${incomeSnap.pendingCoins}/${incomeSnap.capCoins} 🪙 (макс. 12 ч)`,
    `📋 Дейлики сегодня: ${dqDone}/3 ${dq.rewardClaimed ? '(награда забрана ✅)' : ''}`,
    ``,
    `🏅 Ачивки (${unlockedDefs.length}/${ACHIEVEMENTS_CATALOG.length}):`,
    unlockedBadges ? unlockedBadges : 'Пока ни одной — пора крутить стол!'
  ];

  const kb: InlineKeyboard = [
    [
      { text: `🏅 Все ачивки (${unlockedDefs.length}/${ACHIEVEMENTS_CATALOG.length})`, callbackData: 'me:ach' },
      { text: `📋 Дейлики (${dqDone}/3)`, callbackData: 'dq:menu' }
    ],
    [
      { text: '🏷️ Титулы и понты', callbackData: 'tt:menu' },
      { text: '🔥 Костёр (сжечь)', callbackData: 'g:bonfire' }
    ],
    [
      { text: '🎒 Шкатулка', callbackData: 'tl:bag:0' },
      { text: '🏠 В меню', callbackData: 'menu' }
    ]
  ];

  return { text: lines.join('\n'), keyboard: kb };
}

export async function handleProfileCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1] || 'view';

  if (sub === 'ach') {
    const unlockedIds = new Set(player.achievements || []);
    const lines = [
      `🏅 ДОСТИЖЕНИЯ ИГРОКА (${unlockedIds.size}/${ACHIEVEMENTS_CATALOG.length})`,
      `👤 ${playerLabel(chat, player)}`,
      ``
    ];
    for (const a of ACHIEVEMENTS_CATALOG) {
      const mark = unlockedIds.has(a.id) ? '✅' : '🔒';
      lines.push(`${mark} ${a.emoji} ${a.title} — ${a.desc}`);
    }

    await transport.answerCallback(callbackId);
    await transport.editMessage(chat.chatId, messageId, lines.join('\n'), [
      [
        { text: '🪪 К профилю', callbackData: 'me:view' },
        { text: '🏠 В меню', callbackData: 'menu' }
      ]
    ]);
    return;
  }

  await transport.answerCallback(callbackId);
  const view = buildProfileView(chat, player);
  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
  } else {
    await transport.sendMessage(chat.chatId, view.text, view.keyboard);
  }
}

export function getGlobalTopSlotCount(): number {
  return UNIQUE_TALISMANS.length;
}
