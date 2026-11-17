import {
  BotTransport,
  InlineButton,
  InlineKeyboard,
  displayName,
  formatDuration,
  getGhostRemainingMs,
  playerLabel
} from '../engineShared.js';
import {
  ChatState,
  PlayerState,
  addBotLog,
  scheduleSave
} from '../storage.js';
import {
  CLEANSE_PRANK_PRICE,
  PRANK_DURATION_MS,
  PRANK_TITLES,
  SELF_TITLES,
  TITLE_BY_ID,
  formatTitlePrice,
  getActiveTitleTag
} from '../titlesCatalog.js';
import { unlockAchievement } from './profileQuests.js';

const SHOP_PAGE_SIZE = 5;
const TARGET_PAGE_SIZE = 6;

function buildHeaderLines(chat: ChatState, player: PlayerState): string[] {
  const active = getActiveTitleTag(player);
  const ownedCount = (player.ownedTitles || []).length;
  const lines = [
    `🏷️ МАГАЗИН ТИТУЛОВ И ПОНТОВ ДЯДИ ДЕПА`,
    `👤 ${playerLabel(chat, player)}`,
    `🪙 Баланс: ${formatTitlePrice(player.balance)} 🪙 · Куплено титулов: ${ownedCount}/${SELF_TITLES.length}`
  ];
  if (active?.isPrank && active.expiresAt) {
    const left = formatDuration(Math.max(0, active.expiresAt - Date.now()));
    lines.push(`😈 На тебе висит пранк «${active.label}» от ${active.fromName || 'кента'} (ещё ${left})`);
  } else if (active) {
    lines.push(`✨ Активный титул: ${active.label}`);
  } else {
    lines.push(`✨ Активный титул: пока без титула (самое время прикупить понтов!)`);
  }
  return lines;
}

function buildSelfShopView(
  chat: ChatState,
  player: PlayerState,
  pageRaw = 0
): { text: string; keyboard: InlineKeyboard } {
  const totalPages = Math.max(1, Math.ceil(SELF_TITLES.length / SHOP_PAGE_SIZE));
  const page = Math.max(0, Math.min(totalPages - 1, pageRaw));
  const slice = SELF_TITLES.slice(page * SHOP_PAGE_SIZE, (page + 1) * SHOP_PAGE_SIZE);
  const ownedSet = new Set(player.ownedTitles || []);
  const prankActive = Boolean(player.prankTitle && player.prankTitle.expiresAt > Date.now());

  const lines = [
    ...buildHeaderLines(chat, player),
    ``,
    `👑 ЛИЧНЫЕ ТИТУЛЫ НАВСЕГДА (стр. ${page + 1}/${totalPages}):`
  ];

  const kb: InlineKeyboard = [];
  for (const t of slice) {
    const isOwned = ownedSet.has(t.id);
    const isEquipped = !prankActive && player.equippedTitleId === t.id;
    const statusTag = isEquipped ? ' ⭐ [НАДЕТ]' : isOwned ? ' ✅ [В ШКАФУ]' : ` — ${formatTitlePrice(t.price)} 🪙`;
    lines.push(`${t.emoji} ${t.name}${statusTag}\n   └ ${t.desc}`);

    const btnText = isEquipped
      ? `⭐ Снять: ${t.emoji} ${t.name}`
      : isOwned
        ? `👕 Надеть: ${t.emoji} ${t.name}`
        : `💎 ${t.emoji} ${t.name} (${formatTitlePrice(t.price)} 🪙)`;
    kb.push([{ text: btnText, callbackData: isOwned ? `tt:eq:${t.id}:${page}` : `tt:buy:${t.id}:${page}` }]);
  }

  const navRow: InlineButton[] = [];
  if (page > 0) navRow.push({ text: '⬅️ Назад', callbackData: `tt:shop:${page - 1}` });
  if (page < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callbackData: `tt:shop:${page + 1}` });
  if (navRow.length > 0) kb.push(navRow);

  if (prankActive) {
    kb.push([{ text: `🧼 Смыть позорное прозвище (${formatTitlePrice(CLEANSE_PRANK_PRICE)} 🪙)`, callbackData: 'tt:cleanse' }]);
  }

  kb.push([
    { text: '😈 Повесить на кента (24ч)', callbackData: 'tt:pranks:0' },
    { text: `🎒 Мои (${ownedSet.size})`, callbackData: 'tt:bag:0' }
  ]);
  kb.push([{ text: '🏠 В меню', callbackData: 'menu' }]);

  return { text: lines.join('\n'), keyboard: kb };
}

function buildPranksListView(
  chat: ChatState,
  player: PlayerState,
  pageRaw = 0
): { text: string; keyboard: InlineKeyboard } {
  const pageSize = 4;
  const totalPages = Math.max(1, Math.ceil(PRANK_TITLES.length / pageSize));
  const page = Math.max(0, Math.min(totalPages - 1, pageRaw));
  const slice = PRANK_TITLES.slice(page * pageSize, (page + 1) * pageSize);

  const lines = [
    ...buildHeaderLines(chat, player),
    ``,
    `😈 ПРАНК-ПРОЗВИЩА НА СОСЕДА ПО ЧАТУ (на 24 часа, стр. ${page + 1}/${totalPages}):`,
    `Перебивают любой личный титул жертвы и отображаются в топах и играх!`
  ];

  const kb: InlineKeyboard = [];
  for (const t of slice) {
    lines.push(`${t.emoji} ${t.name} — ${formatTitlePrice(t.price)} 🪙\n   └ ${t.desc}`);
    kb.push([{ text: `🎯 Выбрать жертву: ${t.emoji} ${t.name} (${formatTitlePrice(t.price)} 🪙)`, callbackData: `tt:target:${t.id}:0` }]);
  }

  const navRow: InlineButton[] = [];
  if (page > 0) navRow.push({ text: '⬅️ Назад', callbackData: `tt:pranks:${page - 1}` });
  if (page < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callbackData: `tt:pranks:${page + 1}` });
  if (navRow.length > 0) kb.push(navRow);

  kb.push([
    { text: '👑 Личные титулы', callbackData: 'tt:shop:0' },
    { text: '🏠 В меню', callbackData: 'menu' }
  ]);

  return { text: lines.join('\n'), keyboard: kb };
}

function buildPrankTargetView(
  chat: ChatState,
  player: PlayerState,
  prankId: string,
  pageRaw = 0
): { text: string; keyboard: InlineKeyboard } | null {
  const def = TITLE_BY_ID[prankId];
  if (!def || def.category !== 'prank') return null;

  const others = Object.values(chat.players)
    .filter((p) => p.userId !== player.userId)
    .sort((a, b) => b.balance - a.balance || a.firstName.localeCompare(b.firstName));

  const totalPages = Math.max(1, Math.ceil(others.length / TARGET_PAGE_SIZE));
  const page = Math.max(0, Math.min(totalPages - 1, pageRaw));
  const slice = others.slice(page * TARGET_PAGE_SIZE, (page + 1) * TARGET_PAGE_SIZE);

  const lines = [
    `😈 КОМУ ПОВЕСИТЬ «${def.emoji} ${def.name}»?`,
    `💰 Цена пранка: ${formatTitlePrice(def.price)} 🪙 · Срок: 24 часа`,
    `🪙 Твой баланс: ${formatTitlePrice(player.balance)} 🪙`,
    ``,
    others.length > 0
      ? `Выбери счастливчика из чата (стр. ${page + 1}/${totalPages}):`
      : `В этом чате пока нет других игроков — зови друзей!`
  ];

  const kb: InlineKeyboard = [];
  for (const target of slice) {
    kb.push([
      {
        text: `🎯 ${displayName(target)} (${formatTitlePrice(target.balance)} 🪙)`,
        callbackData: `tt:prank:${prankId}:${target.userId}`
      }
    ]);
  }

  const navRow: InlineButton[] = [];
  if (page > 0) navRow.push({ text: '⬅️ Назад', callbackData: `tt:target:${prankId}:${page - 1}` });
  if (page < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callbackData: `tt:target:${prankId}:${page + 1}` });
  if (navRow.length > 0) kb.push(navRow);

  kb.push([
    { text: '↩️ К пранкам', callbackData: 'tt:pranks:0' },
    { text: '🏠 В меню', callbackData: 'menu' }
  ]);

  return { text: lines.join('\n'), keyboard: kb };
}

function buildOwnedTitlesView(
  chat: ChatState,
  player: PlayerState,
  pageRaw = 0
): { text: string; keyboard: InlineKeyboard } {
  const ownedIds = player.ownedTitles || [];
  const ownedDefs = SELF_TITLES.filter((t) => ownedIds.includes(t.id));
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(ownedDefs.length / pageSize));
  const page = Math.max(0, Math.min(totalPages - 1, pageRaw));
  const slice = ownedDefs.slice(page * pageSize, (page + 1) * pageSize);

  const lines = [
    ...buildHeaderLines(chat, player),
    ``,
    ownedDefs.length > 0
      ? `🎒 ТВОИ КУПЛЕННЫЕ ТИТУЛЫ (${ownedDefs.length}):`
      : `🎒 У тебя пока нет ни одного личного титула — загляни в магазин!`
  ];

  const kb: InlineKeyboard = [];
  for (const t of slice) {
    const isEq = player.equippedTitleId === t.id;
    lines.push(`${isEq ? '⭐' : '•'} ${t.emoji} ${t.name}`);
    kb.push([
      {
        text: isEq ? `⭐ Снять: ${t.emoji} ${t.name}` : `👕 Надеть: ${t.emoji} ${t.name}`,
        callbackData: `tt:eq:${t.id}:bag`
      }
    ]);
  }

  if (player.equippedTitleId) {
    kb.push([{ text: '🚫 Снять текущий титул', callbackData: 'tt:eq:none:bag' }]);
  }

  const navRow: InlineButton[] = [];
  if (page > 0) navRow.push({ text: '⬅️ Назад', callbackData: `tt:bag:${page - 1}` });
  if (page < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callbackData: `tt:bag:${page + 1}` });
  if (navRow.length > 0) kb.push(navRow);

  kb.push([
    { text: '👑 Магазин титулов', callbackData: 'tt:shop:0' },
    { text: '🏠 В меню', callbackData: 'menu' }
  ]);

  return { text: lines.join('\n'), keyboard: kb };
}

export async function handleTitlesCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1] || 'menu';

  const render = async (view: { text: string; keyboard: InlineKeyboard }) => {
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    } else {
      await transport.sendMessage(chat.chatId, view.text, view.keyboard);
    }
  };

  if (sub === 'menu' || sub === 'shop') {
    const page = parseInt(parts[2] || '0', 10) || 0;
    await transport.answerCallback(callbackId);
    await render(buildSelfShopView(chat, player, page));
    return;
  }

  if (sub === 'pranks') {
    const page = parseInt(parts[2] || '0', 10) || 0;
    await transport.answerCallback(callbackId);
    await render(buildPranksListView(chat, player, page));
    return;
  }

  if (sub === 'target') {
    const prankId = parts[2] || '';
    const page = parseInt(parts[3] || '0', 10) || 0;
    const view = buildPrankTargetView(chat, player, prankId, page);
    if (!view) {
      await transport.answerCallback(callbackId, 'Пранк не найден.', true);
      return;
    }
    await transport.answerCallback(callbackId);
    await render(view);
    return;
  }

  if (sub === 'bag') {
    const page = parseInt(parts[2] || '0', 10) || 0;
    await transport.answerCallback(callbackId);
    await render(buildOwnedTitlesView(chat, player, page));
    return;
  }

  if (sub === 'eq') {
    const targetId = parts[2] || '';
    const returnLoc = parts[3] || '0';
    if (targetId === 'none') {
      player.equippedTitleId = null;
      scheduleSave();
      await transport.answerCallback(callbackId, 'Титул снят.');
    } else {
      const def = TITLE_BY_ID[targetId];
      if (!def || !(player.ownedTitles || []).includes(targetId)) {
        await transport.answerCallback(callbackId, 'Сначала купи этот титул!', true);
        return;
      }
      if (player.equippedTitleId === targetId) {
        player.equippedTitleId = null;
        await transport.answerCallback(callbackId, `Снял титул «${def.name}».`);
      } else {
        player.equippedTitleId = targetId;
        await transport.answerCallback(callbackId, `Надет титул ${def.emoji} ${def.name}!`);
      }
      scheduleSave();
    }
    if (returnLoc === 'bag') {
      await render(buildOwnedTitlesView(chat, player, 0));
    } else {
      await render(buildSelfShopView(chat, player, parseInt(returnLoc, 10) || 0));
    }
    return;
  }

  if (sub === 'buy') {
    const titleId = parts[2] || '';
    const page = parseInt(parts[3] || '0', 10) || 0;
    const def = TITLE_BY_ID[titleId];
    if (!def || def.category !== 'self') {
      await transport.answerCallback(callbackId, 'Титул не найден.', true);
      return;
    }
    if (!player.ownedTitles) player.ownedTitles = [];
    if (player.ownedTitles.includes(def.id)) {
      player.equippedTitleId = def.id;
      scheduleSave();
      await transport.answerCallback(callbackId, `Надет титул ${def.emoji} ${def.name}!`);
      await render(buildSelfShopView(chat, player, page));
      return;
    }

    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призракам нельзя покупать понты (жди ${formatDuration(ghostMs)})!`, true);
      return;
    }
    if (player.balance < def.price) {
      await transport.answerCallback(
        callbackId,
        `Не хватает фантиков! Нужно ${formatTitlePrice(def.price)} 🪙, у тебя ${formatTitlePrice(player.balance)} 🪙.`,
        true
      );
      return;
    }

    player.balance -= def.price;
    player.ownedTitles.push(def.id);
    player.equippedTitleId = def.id;
    unlockAchievement(chat, player, 'title_collector');
    scheduleSave();

    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: `Покупка титула: ${def.emoji} ${def.name}`,
      detail: `Потрачено ${formatTitlePrice(def.price)} 🪙`
    });

    await transport.answerCallback(callbackId, `👑 Куплен титул «${def.emoji} ${def.name}»!`);
    await render(buildSelfShopView(chat, player, page));
    return;
  }

  if (sub === 'prank') {
    const prankId = parts[2] || '';
    const targetUserId = parts[3] || '';
    const def = TITLE_BY_ID[prankId];
    const target = chat.players[targetUserId];
    if (!def || def.category !== 'prank' || !target) {
      await transport.answerCallback(callbackId, 'Пранк или игрок не найден.', true);
      return;
    }
    if (target.userId === player.userId) {
      await transport.answerCallback(callbackId, 'Себе позор покупать нельзя — выбери друга!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призракам нельзя пранковать (жди ${formatDuration(ghostMs)})!`, true);
      return;
    }
    if (player.balance < def.price) {
      await transport.answerCallback(
        callbackId,
        `Не хватает фантиков! Пранк стоит ${formatTitlePrice(def.price)} 🪙, у тебя ${formatTitlePrice(player.balance)} 🪙.`,
        true
      );
      return;
    }

    player.balance -= def.price;
    target.prankTitle = {
      titleId: def.id,
      fromName: displayName(player),
      expiresAt: Date.now() + PRANK_DURATION_MS
    };
    unlockAchievement(chat, player, 'title_collector');
    scheduleSave();

    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: `Пранк на ${displayName(target)}: ${def.emoji} ${def.name}`,
      detail: `Потрачено ${formatTitlePrice(def.price)} 🪙 (на 24 часа)`
    });

    await transport.answerCallback(callbackId, `😈 Прозвище повешено на ${displayName(target)}!`);
    const confirmText = [
      `😈 ПРАНК-УДАР ОТ ДЯДИ ДЕПА!`,
      `💸 ${displayName(player)} не пожалел ${formatTitlePrice(def.price)} 🪙 и выдал новое звание в чате:`,
      ``,
      `🎯 Жертва: ${playerLabel(chat, target)}`,
      `⏳ Срок действия: ровно 24 часа!`,
      `🪙 Твой баланс: ${formatTitlePrice(player.balance)} 🪙`,
      ``,
      `Теперь весь чат будет видеть этот шедевр в играх и на Доске почёта!`
    ].join('\n');
    await render({
      text: confirmText,
      keyboard: [
        [
          { text: '😈 Пранкануть ещё', callbackData: 'tt:pranks:0' },
          { text: '👑 Магазин титулов', callbackData: 'tt:shop:0' }
        ],
        [{ text: '🏠 В меню', callbackData: 'menu' }]
      ]
    });
    return;
  }

  if (sub === 'cleanse') {
    if (!player.prankTitle || player.prankTitle.expiresAt <= Date.now()) {
      player.prankTitle = null;
      await transport.answerCallback(callbackId, 'На тебе нет активного пранка!');
      await render(buildSelfShopView(chat, player, 0));
      return;
    }
    if (player.balance < CLEANSE_PRANK_PRICE) {
      await transport.answerCallback(
        callbackId,
        `Смыть позор стоит ${formatTitlePrice(CLEANSE_PRANK_PRICE)} 🪙, у тебя ${formatTitlePrice(player.balance)} 🪙.`,
        true
      );
      return;
    }
    player.balance -= CLEANSE_PRANK_PRICE;
    player.prankTitle = null;
    scheduleSave();

    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: 'Откуп от пранк-прозвища',
      detail: `Потрачено ${formatTitlePrice(CLEANSE_PRANK_PRICE)} 🪙`
    });

    await transport.answerCallback(callbackId, '🧼 Прозвище смыто!');
    await render(buildSelfShopView(chat, player, 0));
    return;
  }

  await transport.answerCallback(callbackId);
}
