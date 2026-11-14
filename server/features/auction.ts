import {
  BotTransport,
  InlineKeyboard,
  applyAutoDebtCollection,
  displayName,
  formatDuration,
  getGhostRemainingMs,
  playerLabel,
  shortId
} from '../engineShared.js';
import {
  ChatState,
  OwnedTalisman,
  PlayerState,
  addBotLog,
  getDb,
  scheduleSave
} from '../storage.js';
import { RARITY_META, TALISMAN_BY_ID } from '../talismans.js';
import { unlockAchievement } from './profileQuests.js';
import { syncTalismanPassiveIncome } from './talismanIncome.js';
import {
  isServerlessRuntime,
  markRuntimeDirty,
  registerRuntimeAdapter,
  resolveRuntimeTransport
} from '../runtimeRegistry.js';

const AUCTION_DURATION_MS = 60_000;
const AUCTION_MAX_DURATION_MS = 120_000;
const AUCTION_SNIPE_WINDOW_MS = 15_000;
const AUCTION_SNIPE_EXTEND_MS = 15_000;

interface TalismanAuction {
  id: string;
  chatId: string;
  sellerId: string;
  sellerName: string;
  item: OwnedTalisman;
  talismanId: string;
  startPrice: number;
  currentBid: number;
  highestBidderId: string | null;
  highestBidderName: string | null;
  bidsCount: number;
  status: 'active' | 'finished';
  messageId: string | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
  endsAt: number;
  maxEndsAt: number;
  finishTimer: NodeJS.Timeout | null;
}

const auctions = new Map<string, TalismanAuction>();

function getAuctionTransport(auc: TalismanAuction): BotTransport | null {
  return resolveRuntimeTransport(auc.transportSource, auc.chatId, auc.transport);
}

registerRuntimeAdapter('auctions', {
  exportState: () =>
    Array.from(auctions.values()).map(({ finishTimer: _t, transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
  importState: (raw: any) => {
    for (const a of auctions.values()) {
      if (a.finishTimer) clearTimeout(a.finishTimer);
    }
    auctions.clear();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item?.id || item.status !== 'active') continue;
        auctions.set(item.id, {
          ...item,
          transport: null,
          finishTimer: null
        });
      }
    }
  }
});

export function findActiveAuctionForChat(chatId: string): TalismanAuction | null {
  for (const auc of auctions.values()) {
    if (auc.chatId === chatId && auc.status === 'active') {
      return auc;
    }
  }
  return null;
}

export function isAuctionProtectedMsg(msgId: string): boolean {
  for (const auc of auctions.values()) {
    if (auc.status === 'active' && auc.messageId === msgId) return true;
  }
  return false;
}

function returnItemToSeller(chat: ChatState, auc: TalismanAuction): void {
  const seller = chat.players[auc.sellerId];
  if (!seller) return;
  syncTalismanPassiveIncome(seller);
  if (!seller.talismans) seller.talismans = [];
  seller.talismans.push(auc.item);
  const def = TALISMAN_BY_ID[auc.talismanId];
  if (def?.rarity === 'unique') {
    if (!chat.uniqueTalismans) chat.uniqueTalismans = {};
    chat.uniqueTalismans[auc.talismanId] = {
      ownerId: seller.userId,
      ownerName: displayName(seller),
      obtainedAt: auc.item.obtainedAt || Date.now()
    };
  }
}

function buildAuctionCard(chat: ChatState, auc: TalismanAuction): { text: string; keyboard: InlineKeyboard } {
  const def = TALISMAN_BY_ID[auc.talismanId];
  const meta = def ? RARITY_META[def.rarity] : RARITY_META.common;
  const seller = chat.players[auc.sellerId];
  const sellerDisplay = seller ? playerLabel(chat, seller) : auc.sellerName;
  const leftSec = Math.max(0, Math.ceil((auc.endsAt - Date.now()) / 1000));

  const leaderObj = auc.highestBidderId ? chat.players[auc.highestBidderId] : null;
  const leaderDisplay = leaderObj
    ? playerLabel(chat, leaderObj)
    : auc.highestBidderName || 'пока нет ставок';

  const recycleInfo =
    def && def.rarity === 'unique'
      ? '🔴 Реликвия 1/1 (бесценная, только 1 на весь чат!)'
      : `♻️ Оценка переработки: ${def?.recycleValue || 0} 🪙`;

  const lines = [
    `🔨 АУКЦИОН РЕЛИКВИЙ ДЯДИ ДЕПА`,
    ``,
    `🎁 Лот: ${meta.badge} ${def ? `${def.emoji} ${def.name}` : auc.talismanId} (${meta.label})`,
    def ? `📜 «${def.lore}»` : '',
    recycleInfo,
    `👤 Продавец: ${sellerDisplay}`,
    ``,
    auc.bidsCount === 0
      ? `💰 Стартовая цена: ${auc.startPrice} 🪙 (ставок пока 0)`
      : `💰 Текущая ставка: ${auc.currentBid} 🪙 (лидер: ${leaderDisplay}, ставок: ${auc.bidsCount})`,
    `⏱ Осталось времени: ~${leftSec} сек`,
    `ℹ️ Ставка за <15 сек до конца продлевает торги на +15 сек.`
  ].filter(Boolean);

  const kb: InlineKeyboard = [];
  if (auc.bidsCount === 0) {
    kb.push([
      {
        text: `🔨 Перебить / Взять за ${auc.startPrice} 🪙`,
        callbackData: `auc:bid:${auc.id}:start`
      }
    ]);
  } else {
    kb.push([
      { text: `+50 (${auc.currentBid + 50} 🪙)`, callbackData: `auc:bid:${auc.id}:50` },
      { text: `+150 (${auc.currentBid + 150} 🪙)`, callbackData: `auc:bid:${auc.id}:150` },
      { text: `+500 (${auc.currentBid + 500} 🪙)`, callbackData: `auc:bid:${auc.id}:500` }
    ]);
  }

  const bottomRow = [{ text: '🔄 Обновить', callbackData: `auc:refresh:${auc.id}` }];
  if (auc.bidsCount === 0) {
    bottomRow.push({ text: '❌ Снять лот', callbackData: `auc:cancel:${auc.id}` });
  }
  kb.push(bottomRow);

  return { text: lines.join('\n'), keyboard: kb };
}

function scheduleAuctionFinish(auc: TalismanAuction): void {
  if (isServerlessRuntime()) return;
  if (auc.finishTimer) {
    clearTimeout(auc.finishTimer);
    auc.finishTimer = null;
  }
  const delay = Math.max(250, auc.endsAt - Date.now());
  auc.finishTimer = setTimeout(() => {
    void finishAuction(auc.id);
  }, delay);
}

async function finishAuction(aucId: string): Promise<void> {
  const auc = auctions.get(aucId);
  if (!auc || auc.status !== 'active') return;
  auc.status = 'finished';
  if (auc.finishTimer) {
    clearTimeout(auc.finishTimer);
    auc.finishTimer = null;
  }
  auctions.delete(aucId);
  markRuntimeDirty();

  const chat = getDb().chats[auc.chatId];
  const def = TALISMAN_BY_ID[auc.talismanId];
  const meta = def ? RARITY_META[def.rarity] : RARITY_META.common;
  const lotLabel = `${meta.badge} ${def ? `${def.emoji} ${def.name}` : auc.talismanId}`;
  const tr = getAuctionTransport(auc);

  if (!chat) return;

  if (auc.bidsCount === 0 || !auc.highestBidderId) {
    returnItemToSeller(chat, auc);
    scheduleSave();

    addBotLog({
      source: tr?.source || 'telegram',
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: auc.sellerName,
      event: 'Аукцион без ставок',
      detail: `Лот ${def?.name || auc.talismanId} возвращён продавцу`
    });

    if (auc.messageId && tr) {
      await tr.editMessage(
        chat.chatId,
        auc.messageId,
        [
          `🔨 АУКЦИОН ЗАВЕРШЁН — БЕЗ СТАВОК`,
          `🎁 Лот: ${lotLabel}`,
          ``,
          `Никто не решился поднять ставку от ${auc.startPrice} 🪙.`,
          `🎒 Талисман возвращён в шкатулку владельца (${auc.sellerName}).`
        ].join('\n'),
        [
          [
            { text: '🔨 Новый лот', callbackData: 'auc:menu' },
            { text: '🏠 В меню', callbackData: 'menu' }
          ]
        ]
      );
    }
    return;
  }

  const winner = chat.players[auc.highestBidderId];
  const seller = chat.players[auc.sellerId];
  const finalPrice = auc.currentBid;

  if (winner) {
    syncTalismanPassiveIncome(winner);
    if (!winner.talismans) winner.talismans = [];
    winner.talismans.push({
      instanceId: auc.item.instanceId,
      talismanId: auc.talismanId,
      obtainedAt: Date.now()
    });
    if (def?.rarity === 'unique') {
      if (!chat.uniqueTalismans) chat.uniqueTalismans = {};
      chat.uniqueTalismans[auc.talismanId] = {
        ownerId: winner.userId,
        ownerName: displayName(winner),
        obtainedAt: Date.now()
      };
      unlockAchievement(chat, winner, 'collector_unique');
    }
  } else {
    returnItemToSeller(chat, auc);
  }

  if (seller && winner) {
    seller.balance += finalPrice;
    if (seller.balance >= 5000) unlockAchievement(chat, seller, 'oligarch_5k');
  }
  scheduleSave();

  const winnerDisplay = winner ? playerLabel(chat, winner) : auc.highestBidderName || 'Покупатель';
  const sellerDisplay = seller ? playerLabel(chat, seller) : auc.sellerName;

  addBotLog({
    source: tr?.source || 'telegram',
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: winner ? displayName(winner) : auc.highestBidderName || undefined,
    event: `Аукцион: продан за ${finalPrice} 🪙`,
    detail: `${def?.name || auc.talismanId} → от ${auc.sellerName} к ${auc.highestBidderName}`
  });

  if (auc.messageId && tr) {
    await tr.editMessage(
      chat.chatId,
      auc.messageId,
      [
        `🔨 ПРОДАНО! МОЛОТОК УДАРЕН!`,
        ``,
        `🎁 Лот: ${lotLabel}`,
        `🏆 Победитель: ${winnerDisplay}`,
        `💰 Итоговая цена: ${finalPrice} 🪙 (ставок: ${auc.bidsCount})`,
        `🤝 Продавец ${sellerDisplay} получил +${finalPrice} фантиков на счёт!`
      ].join('\n'),
      [
        [
          { text: '🎒 Моя шкатулка', callbackData: 'tl:bag:0' },
          { text: '🔨 Новый аукцион', callbackData: 'auc:menu' }
        ],
        [{ text: '🏠 В меню', callbackData: 'menu' }]
      ]
    );
  }

  if (seller && winner && finalPrice > 0 && tr) {
    await applyAutoDebtCollection(tr, chat, seller, finalPrice);
  }
}

export async function sweepExpiredAuctions(now = Date.now()): Promise<void> {
  const graceMs = isServerlessRuntime() ? 0 : 1500;
  for (const auc of Array.from(auctions.values())) {
    if (auc.status === 'active' && now >= auc.endsAt + graceMs) {
      await finishAuction(auc.id);
    }
  }
}

function getSortedSellerTalismans(player: PlayerState): OwnedTalisman[] {
  return [...(player.talismans || [])].sort((a, b) => {
    const da = TALISMAN_BY_ID[a.talismanId];
    const dbDef = TALISMAN_BY_ID[b.talismanId];
    const oa = da ? RARITY_META[da.rarity].order : 0;
    const ob = dbDef ? RARITY_META[dbDef.rarity].order : 0;
    if (ob !== oa) return ob - oa;
    return b.obtainedAt - a.obtainedAt;
  });
}

function renderAuctionPicker(
  chat: ChatState,
  player: PlayerState,
  page: number
): { text: string; keyboard: InlineKeyboard } {
  const list = getSortedSellerTalismans(player);
  const perPage = 6;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = list.slice(safePage * perPage, (safePage + 1) * perPage);

  if (list.length === 0) {
    return {
      text: [
        `🔨 АУКЦИОН РЕЛИКВИЙ`,
        `👤 ${playerLabel(chat, player)} | Баланс: ${player.balance} 🪙`,
        ``,
        `У тебя пока пустая шкатулка — выставлять на торги нечего!`,
        `Открой кейс в «🧳 Кейсы и крафт» и возвращайся на аукцион.`
      ].join('\n'),
      keyboard: [
        [
          { text: '🛒 Купить кейс', callbackData: 'tl:shop' },
          { text: '🏠 В меню', callbackData: 'menu' }
        ]
      ]
    };
  }

  const lines = [
    `🔨 АУКЦИОН РЕЛИКВИЙ — ВЫСТАВИТЬ ЛОТ`,
    `👤 Продавец: ${playerLabel(chat, player)} | В шкатулке: ${list.length} шт.`,
    ``,
    `Выбери талисман, который хочешь пустить с молотка на 60 сек в чате (стр. ${safePage + 1}/${totalPages}):`
  ];

  const kb: InlineKeyboard = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = slice.slice(i, i + 2).map((inst) => {
      const def = TALISMAN_BY_ID[inst.talismanId];
      const badge = def ? RARITY_META[def.rarity].badge : '⚪';
      const label = def ? `${badge} ${def.emoji} ${def.name}` : inst.talismanId;
      return { text: label.slice(0, 28), callbackData: `auc:price:${inst.instanceId}` };
    });
    kb.push(row);
  }

  if (totalPages > 1) {
    const navRow = [];
    if (safePage > 0) navRow.push({ text: '⬅️ Назад', callbackData: `auc:pick:${safePage - 1}` });
    if (safePage < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callbackData: `auc:pick:${safePage + 1}` });
    if (navRow.length > 0) kb.push(navRow);
  }

  kb.push([
    { text: '🧳 Кейсы и крафт', callbackData: 'tl:menu' },
    { text: '🏠 В меню', callbackData: 'menu' }
  ]);

  return { text: lines.join('\n'), keyboard: kb };
}

export async function handleAuctionCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1] || 'menu';

  const sendOrEdit = async (text: string, kb: InlineKeyboard): Promise<string | null> => {
    if (messageId) {
      await transport.editMessage(chat.chatId, messageId, text, kb);
      return messageId;
    }
    return transport.sendMessage(chat.chatId, text, kb);
  };

  if (sub === 'menu') {
    await sweepExpiredAuctions();
    const active = findActiveAuctionForChat(chat.chatId);
    if (active) {
      await transport.answerCallback(callbackId);
      const card = buildAuctionCard(chat, active);
      await sendOrEdit(card.text, card.keyboard);
      return;
    }
    await transport.answerCallback(callbackId);
    const view = renderAuctionPicker(chat, player, 0);
    await sendOrEdit(view.text, view.keyboard);
    return;
  }

  if (sub === 'pick') {
    const page = parseInt(parts[2] || '0', 10) || 0;
    await transport.answerCallback(callbackId);
    const view = renderAuctionPicker(chat, player, page);
    await sendOrEdit(view.text, view.keyboard);
    return;
  }

  if (sub === 'price') {
    const instId = parts[2];
    const active = findActiveAuctionForChat(chat.chatId);
    if (active) {
      await transport.answerCallback(callbackId, 'В чате уже идёт активный аукцион! Сначала доторгуйте его.', true);
      return;
    }

    const inst = (player.talismans || []).find((t) => t.instanceId === instId);
    if (!inst) {
      await transport.answerCallback(callbackId, 'Этот талисман больше не в твоей шкатулке.', true);
      return;
    }

    const def = TALISMAN_BY_ID[inst.talismanId];
    const meta = def ? RARITY_META[def.rarity] : RARITY_META.common;
    const presets =
      def?.rarity === 'unique'
        ? [1000, 2500, 5000, 8000]
        : def?.rarity === 'legendary'
          ? [1000, 2000, 3500, 5000]
          : def?.rarity === 'epic'
            ? [500, 1000, 1500, 2500]
            : [100, 250, 500, 1000];

    await transport.answerCallback(callbackId);
    const lines = [
      `🔨 НАСТРОЙКА ЛОТА НА АУКЦИОН`,
      `🎁 Талисман: ${meta.badge} ${def ? `${def.emoji} ${def.name}` : inst.talismanId} (${meta.label})`,
      def ? `📜 «${def.lore}»` : '',
      def && def.rarity !== 'unique' ? `♻️ Цена переработки: ${def.recycleValue} 🪙` : `🔴 Уникальная реликвия 1/1!`,
      ``,
      `Выбери стартовую цену торгов (60 секунд в чате):`
    ].filter(Boolean);

    const kb: InlineKeyboard = [
      presets.slice(0, 2).map((p) => ({
        text: `Старт ${p} 🪙`,
        callbackData: `auc:start:${inst.instanceId}:${p}`
      })),
      presets.slice(2, 4).map((p) => ({
        text: `Старт ${p} 🪙`,
        callbackData: `auc:start:${inst.instanceId}:${p}`
      })),
      [
        { text: '⬅️ Другой талисман', callbackData: 'auc:pick:0' },
        { text: '🏠 В меню', callbackData: 'menu' }
      ]
    ];

    await sendOrEdit(lines.join('\n'), kb);
    return;
  }

  if (sub === 'start') {
    const instId = parts[2];
    const startPrice = Math.max(50, parseInt(parts[3] || '100', 10) || 100);

    const existing = findActiveAuctionForChat(chat.chatId);
    if (existing) {
      await transport.answerCallback(callbackId, 'В этом чате уже идёт аукцион!', true);
      return;
    }

    const idx = (player.talismans || []).findIndex((t) => t.instanceId === instId);
    if (idx === -1) {
      await transport.answerCallback(callbackId, 'Талисман уже продан или переработан.', true);
      return;
    }

    syncTalismanPassiveIncome(player);
    const [removed] = player.talismans!.splice(idx, 1);
    if (
      player.equippedTalismanId === removed.talismanId &&
      !player.talismans!.some((t) => t.talismanId === removed.talismanId)
    ) {
      player.equippedTalismanId = null;
    }
    scheduleSave();

    const now = Date.now();
    const auc: TalismanAuction = {
      id: shortId(),
      chatId: chat.chatId,
      sellerId: player.userId,
      sellerName: displayName(player),
      item: removed,
      talismanId: removed.talismanId,
      startPrice,
      currentBid: 0,
      highestBidderId: null,
      highestBidderName: null,
      bidsCount: 0,
      status: 'active',
      messageId: messageId || null,
      transportSource: transport.source,
      transport,
      createdAt: now,
      endsAt: now + AUCTION_DURATION_MS,
      maxEndsAt: now + AUCTION_MAX_DURATION_MS,
      finishTimer: null
    };
    auctions.set(auc.id, auc);
    markRuntimeDirty();

    const def = TALISMAN_BY_ID[removed.talismanId];
    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: displayName(player),
      event: `Аукцион запущен (старт ${startPrice} 🪙)`,
      detail: `Лот: ${def?.emoji || ''} ${def?.name || removed.talismanId}`
    });

    await transport.answerCallback(callbackId, '🔨 Аукцион открыт в чате!');
    const card = buildAuctionCard(chat, auc);
    const finalMsgId = await sendOrEdit(card.text, card.keyboard);
    if (finalMsgId) auc.messageId = finalMsgId;
    scheduleAuctionFinish(auc);
    return;
  }

  if (sub === 'bid') {
    const aucId = parts[2];
    const mode = parts[3] || 'start';
    const auc = auctions.get(aucId);
    if (!auc || auc.status !== 'active' || Date.now() >= auc.endsAt) {
      if (auc && auc.status === 'active' && Date.now() >= auc.endsAt) {
        await finishAuction(auc.id);
      }
      await transport.answerCallback(callbackId, 'Аукцион уже завершён!', true);
      return;
    }

    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призрак чата не может торговаться (${formatDuration(ghostMs)})!`, true);
      return;
    }

    if (player.userId === auc.sellerId) {
      await transport.answerCallback(callbackId, 'Нельзя делать ставки на собственный лот!', true);
      return;
    }
    if (player.userId === auc.highestBidderId) {
      await transport.answerCallback(callbackId, 'Твоя ставка и так уже лидирует!', true);
      return;
    }

    const newBid =
      auc.bidsCount === 0
        ? auc.startPrice
        : auc.currentBid + Math.max(50, parseInt(mode, 10) || 50);

    if (player.balance < newBid) {
      await transport.answerCallback(
        callbackId,
        `Недостаточно фантиков! Нужно ${newBid} 🪙, у тебя ${player.balance} 🪙.`,
        true
      );
      return;
    }

    // Refund previous highest bidder
    if (auc.highestBidderId && auc.currentBid > 0) {
      const prev = chat.players[auc.highestBidderId];
      if (prev) prev.balance += auc.currentBid;
    }

    player.balance -= newBid;
    auc.currentBid = newBid;
    auc.highestBidderId = player.userId;
    auc.highestBidderName = displayName(player);
    auc.bidsCount += 1;

    const now = Date.now();
    let extended = false;
    if (auc.endsAt - now < AUCTION_SNIPE_WINDOW_MS && auc.endsAt < auc.maxEndsAt) {
      auc.endsAt = Math.min(auc.maxEndsAt, now + AUCTION_SNIPE_EXTEND_MS);
      scheduleAuctionFinish(auc);
      extended = true;
    }
    scheduleSave();

    await transport.answerCallback(
      callbackId,
      extended ? `🔨 Ставка ${newBid} 🪙 принята (+15 сек)!` : `🔨 Ставка ${newBid} 🪙 принята!`
    );

    const card = buildAuctionCard(chat, auc);
    if (auc.messageId) {
      await transport.editMessage(chat.chatId, auc.messageId, card.text, card.keyboard);
    }
    return;
  }

  if (sub === 'cancel') {
    const aucId = parts[2];
    const auc = auctions.get(aucId);
    if (!auc || auc.status !== 'active') {
      await transport.answerCallback(callbackId, 'Аукцион уже завершён.', true);
      return;
    }
    if (player.userId !== auc.sellerId) {
      await transport.answerCallback(callbackId, 'Снять лот может только продавец!', true);
      return;
    }
    if (auc.bidsCount > 0) {
      await transport.answerCallback(callbackId, 'Уже есть ставка — снимать лот поздно!', true);
      return;
    }

    auc.status = 'finished';
    if (auc.finishTimer) {
      clearTimeout(auc.finishTimer);
      auc.finishTimer = null;
    }
    auctions.delete(aucId);
    returnItemToSeller(chat, auc);
    scheduleSave();

    await transport.answerCallback(callbackId, 'Лот снят, талисман возвращён.');
    if (auc.messageId) {
      await transport.editMessage(
        chat.chatId,
        auc.messageId,
        `❌ Продавец ${playerLabel(chat, player)} снял лот с аукциона до первых ставок.`,
        [
          [
            { text: '🔨 Новый аукцион', callbackData: 'auc:menu' },
            { text: '🏠 В меню', callbackData: 'menu' }
          ]
        ]
      );
    }
    return;
  }

  if (sub === 'refresh') {
    const aucId = parts[2];
    const auc = auctions.get(aucId);
    if (!auc || auc.status !== 'active') {
      await transport.answerCallback(callbackId, 'Торги уже закрыты.', true);
      return;
    }
    if (Date.now() >= auc.endsAt) {
      await finishAuction(auc.id);
      await transport.answerCallback(callbackId, 'Время вышло — торги подведены!');
      return;
    }
    await transport.answerCallback(callbackId);
    const card = buildAuctionCard(chat, auc);
    if (auc.messageId) {
      await transport.editMessage(chat.chatId, auc.messageId, card.text, card.keyboard);
    }
    return;
  }

  await transport.answerCallback(callbackId);
}
