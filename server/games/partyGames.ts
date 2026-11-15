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
  playerLabel,
  shortId
} from '../engineShared.js';
import {
  recordGameOutcome,
  recordQuestProgress,
  unlockAchievement
} from '../features/profileQuests.js';
import { RARITY_META, getTalismansByRarity } from '../talismans.js';
import {
  ChatState,
  LOBBY_IDLE_TTL_MS,
  OwnedTalisman,
  PlayerState,
  addBotLog,
  getDb,
  scheduleSave
} from '../storage.js';
import {
  markRuntimeDirty,
  registerRuntimeAdapter,
  resolveRuntimeTransport
} from '../runtimeRegistry.js';

function getPartyTransport(
  source?: 'telegram' | 'simulator',
  chatId?: string,
  tr?: BotTransport | null
): BotTransport | null {
  return resolveRuntimeTransport(source, chatId, tr);
}

// =====================================
// GAME #2: BATTLESHIP 4x4 ("МОРСКОЙ БОЙ")
// =====================================

interface BattleshipSide {
  userId: string;
  firstName: string;
  isLastDodep: boolean;
  isAllIn: boolean;
  ships: number[]; // 4 cell indices on 4x4 (1x2 ship + two 1x1 boats)
  hitsReceived: number[];
  missesReceived: number[];
  shotsTaken: number;
}

interface BattleshipGame {
  id: string;
  chatId: string;
  mode: 'solo' | 'pvp';
  stake: number;
  creatorId: string;
  status: 'waiting' | 'playing' | 'finished';
  sideA: BattleshipSide;
  sideB: BattleshipSide | null; // In solo, sideB.userId === 'DED_BOT'
  turnUserId: string;
  lastEventText: string;
  messageId: string | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
  lastActionAt: number;
}

const battleshipGames = new Map<string, BattleshipGame>();

function generate4x4Ships(): number[] {
  const ships = new Set<number>();
  // 1x two-cell ship (horizontal or vertical)
  const horizontal = Math.random() < 0.5;
  if (horizontal) {
    const r = Math.floor(Math.random() * 4);
    const c = Math.floor(Math.random() * 3);
    ships.add(r * 4 + c);
    ships.add(r * 4 + c + 1);
  } else {
    const r = Math.floor(Math.random() * 3);
    const c = Math.floor(Math.random() * 4);
    ships.add(r * 4 + c);
    ships.add((r + 1) * 4 + c);
  }
  // 2x one-cell boats
  while (ships.size < 4) {
    ships.add(Math.floor(Math.random() * 16));
  }
  return Array.from(ships).sort((a, b) => a - b);
}

function format4x4Ascii(side: BattleshipSide, revealShips: boolean): string {
  const rows: string[] = [];
  for (let r = 0; r < 4; r++) {
    const line: string[] = [];
    for (let c = 0; c < 4; c++) {
      const idx = r * 4 + c;
      if (side.hitsReceived.includes(idx)) line.push('💥');
      else if (side.missesReceived.includes(idx)) line.push('💦');
      else if (revealShips && side.ships.includes(idx)) line.push('🚢');
      else line.push('🌊');
    }
    rows.push(line.join(''));
  }
  return rows.join('\n');
}

function getSoloBattleshipMultiplier(shotsTaken: number): number {
  if (shotsTaken <= 6) return 3.0;
  if (shotsTaken <= 8) return 2.4;
  return 2.0;
}

function buildBattleshipPlayPayload(game: BattleshipGame): { text: string; keyboard: InlineKeyboard } {
  const sideB = game.sideB!;
  const isTurnA = game.turnUserId === game.sideA.userId;
  const targetSide = isTurnA ? sideB : game.sideA;
  const shooterName = isTurnA ? game.sideA.firstName : sideB.firstName;

  const lines: string[] = [
    game.mode === 'solo'
      ? `⚓ МОРСКОЙ БОЙ (4×4) — ПРОТИВ ДЯДИ ДЕПА`
      : `⚓ МОРСКОЙ БОЙ 1×1 (4×4) — PvP ДУЭЛЬ`,
    `🪙 Ставка: ${game.stake} 🪙 · Кораблей у каждого: 3 (4 клетки)`
  ];

  if (game.mode === 'solo') {
    const curMult = getSoloBattleshipMultiplier(game.sideA.shotsTaken + 1);
    lines.push(
      `🎯 Выстрелов: ${game.sideA.shotsTaken} · Текущий бонус за победу: x${curMult.toFixed(1)}`,
      ``,
      `🚢 Твой флот (подбито ${game.sideA.hitsReceived.length}/4):`,
      format4x4Ascii(game.sideA, true),
      ``,
      `🎯 Флот Деда (подбито ${sideB.hitsReceived.length}/4) — жми по воде:`
    );
  } else {
    lines.push(
      `👤 ${game.sideA.firstName}: ${game.sideA.hitsReceived.length}/4 подбито`,
      `👤 ${sideB.firstName}: ${sideB.hitsReceived.length}/4 подбито`,
      ``,
      `🎯 Сейчас бьёт: ${shooterName} (попал = ещё выстрел!)`
    );
  }

  if (game.lastEventText) {
    lines.push(``, game.lastEventText);
  }

  const kb: InlineKeyboard = [];
  for (let r = 0; r < 4; r++) {
    const row: InlineButton[] = [];
    for (let c = 0; c < 4; c++) {
      const idx = r * 4 + c;
      let label = '🌊';
      if (targetSide.hitsReceived.includes(idx)) label = '💥';
      else if (targetSide.missesReceived.includes(idx)) label = '💦';
      row.push({ text: label, callbackData: `bs:fire:${game.id}:${idx}` });
    }
    kb.push(row);
  }

  if (game.mode === 'pvp') {
    kb.push([{ text: '🚢 Мои корабли (секрет)', callbackData: `bs:peek:${game.id}` }]);
  }

  return { text: lines.join('\n'), keyboard: kb };
}

function buildBattleshipWaitingPayload(game: BattleshipGame): { text: string; keyboard: InlineKeyboard } {
  const lines = [
    `⚓ МОРСКОЙ БОЙ 1×1 — ОЖИДАНИЕ СОПЕРНИКА`,
    `👤 Инициатор: ${game.sideA.firstName} · Ставка: ${game.stake} 🪙`,
    `🗺 Поле 4×4 · 3 корабля (4 клетки) · Попал — бьёшь ещё!`,
    `🏆 Победитель забирает банк ${game.stake * 2} 🪙 (x2)!`
  ];
  const kb: InlineKeyboard = [
    [{ text: `⚔️ Принять бой (${game.stake} 🪙)`, callbackData: `bs:join:${game.id}` }],
    [{ text: '❌ Отменить вызов', callbackData: `bs:cancel:${game.id}` }]
  ];
  return { text: lines.join('\n'), keyboard: kb };
}

export async function startBattleshipMenu(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  stake: number,
  isLastDodep: boolean,
  messageId?: string
): Promise<void> {
  const ldFlag = isLastDodep ? '1' : '0';
  const text = [
    `⚓ МОРСКОЙ БОЙ (4×4 · 3 КОРАБЛЯ)`,
    `👤 Игрок: ${playerLabel(chat, player)} | Ставка: ${stake} 🪙`,
    ``,
    `Выбери режим:`,
    `• 🤖 Против Деда — победа до x3.0 (≤6 выстр. x3.0, ≤8 выстр. x2.4, иначе x2.0)`,
    `• ⚔️ PvP 1×1 в чате — победитель забирает весь банк x2!`
  ].join('\n');

  const kb: InlineKeyboard = [
    [{ text: '🤖 Играть против Деда', callbackData: `bs:solo:${stake}:${ldFlag}` }],
    [{ text: '⚔️ PvP-вызов в чат (1×1)', callbackData: `bs:pvp:${stake}:${ldFlag}` }],
    [{ text: '↩️ В меню игр', callbackData: 'menu:games:pvp' }]
  ];

  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, text, kb);
  } else {
    await transport.sendMessage(chat.chatId, text, kb);
  }
}

export async function handleBattleshipCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];

  if (sub === 'solo' || sub === 'pvp') {
    const stake = parseInt(parts[2] || '0', 10);
    const isLastDodep = parts[3] === '1';
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    if (!Number.isFinite(stake) || stake <= 0 || player.balance < stake) {
      await transport.answerCallback(callbackId, `Недостаточно фантиков (баланс ${player.balance} 🪙)!`, true);
      return;
    }

    const isAllIn = deductPlayerStake(player, stake);
    scheduleSave();

    const id = shortId();
    const sideA: BattleshipSide = {
      userId: player.userId,
      firstName: displayName(player),
      isLastDodep,
      isAllIn,
      ships: generate4x4Ships(),
      hitsReceived: [],
      missesReceived: [],
      shotsTaken: 0
    };

    if (sub === 'solo') {
      const sideB: BattleshipSide = {
        userId: 'DED_BOT',
        firstName: 'Дядя Деп',
        isLastDodep: false,
        isAllIn: false,
        ships: generate4x4Ships(),
        hitsReceived: [],
        missesReceived: [],
        shotsTaken: 0
      };
      const game: BattleshipGame = {
        id,
        chatId: chat.chatId,
        mode: 'solo',
        stake,
        creatorId: player.userId,
        status: 'playing',
        sideA,
        sideB,
        turnUserId: player.userId,
        lastEventText: '🌊 Залп за тобой! Выбирай клетку на поле Деда.',
        messageId,
        transportSource: transport.source,
        transport,
        createdAt: Date.now(),
        lastActionAt: Date.now()
      };
      battleshipGames.set(id, game);
      markRuntimeDirty();
      await transport.answerCallback(callbackId, '⚓ Бой против Деда начался!');
      const payload = buildBattleshipPlayPayload(game);
      await transport.editMessage(chat.chatId, messageId, payload.text, payload.keyboard);
      return;
    }

    // PvP lobby
    const game: BattleshipGame = {
      id,
      chatId: chat.chatId,
      mode: 'pvp',
      stake,
      creatorId: player.userId,
      status: 'waiting',
      sideA,
      sideB: null,
      turnUserId: player.userId,
      lastEventText: '',
      messageId,
      transportSource: transport.source,
      transport,
      createdAt: Date.now(),
      lastActionAt: Date.now()
    };
    battleshipGames.set(id, game);
    markRuntimeDirty();
    await transport.answerCallback(callbackId, '⚔️ Вызов на Морской бой открыт!');
    const view = buildBattleshipWaitingPayload(game);
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    return;
  }

  const gid = parts[2];
  const game = battleshipGames.get(gid);
  if (!game) {
    await transport.answerCallback(callbackId, 'Этот морской бой уже завершён.', true);
    return;
  }

  if (sub === 'cancel') {
    if (game.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Бой уже начался!', true);
      return;
    }
    if (game.creatorId !== player.userId) {
      await transport.answerCallback(callbackId, 'Отменить вызов может только создатель!', true);
      return;
    }
    game.status = 'finished';
    battleshipGames.delete(gid);
    markRuntimeDirty();
    const creator = chat.players[game.creatorId];
    if (creator) creator.balance += game.stake;
    scheduleSave();
    await transport.answerCallback(callbackId, 'Вызов отменён, ставка возвращена.');
    await transport.editMessage(
      chat.chatId,
      game.messageId || messageId,
      `❌ Вызов на Морской бой отменён. Ставка ${game.stake} 🪙 возвращена.`,
      [[{ text: '🏠 В меню', callbackData: 'menu' }]]
    );
    return;
  }

  if (sub === 'join') {
    if (game.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Бой уже идёт!', true);
      return;
    }
    if (game.creatorId === player.userId) {
      await transport.answerCallback(callbackId, 'Нельзя воевать с самим собой — жди соперника или выбери режим против Деда!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    if (player.balance < game.stake) {
      await transport.answerCallback(callbackId, `Нужно ${game.stake} 🪙 (у тебя ${player.balance} 🪙)!`, true);
      return;
    }

    const isAllIn = deductPlayerStake(player, game.stake);
    game.sideB = {
      userId: player.userId,
      firstName: displayName(player),
      isLastDodep: false,
      isAllIn,
      ships: generate4x4Ships(),
      hitsReceived: [],
      missesReceived: [],
      shotsTaken: 0
    };
    game.status = 'playing';
    game.turnUserId = game.sideA.userId;
    game.lastActionAt = Date.now();
    game.lastEventText = `⚔️ ${game.sideB.firstName} принял бой! Первый залп за ${game.sideA.firstName}.`;
    markRuntimeDirty();
    scheduleSave();

    await transport.answerCallback(callbackId, '⚔️ Бой начался! Свои корабли смотри кнопкой внизу.');
    const view = buildBattleshipPlayPayload(game);
    await transport.editMessage(chat.chatId, game.messageId || messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'peek') {
    const side =
      game.sideA.userId === player.userId
        ? game.sideA
        : game.sideB?.userId === player.userId
          ? game.sideB
          : null;
    if (!side) {
      await transport.answerCallback(callbackId, 'Ты не участвуешь в этом бою!', true);
      return;
    }
    const board = format4x4Ascii(side, true).replace(/\n/g, ' | ');
    await transport.answerCallback(
      callbackId,
      `🚢 Твой флот (подбито ${side.hitsReceived.length}/4):\n${board}`,
      true
    );
    return;
  }

  if (sub === 'fire') {
    if (game.status !== 'playing' || !game.sideB) {
      await transport.answerCallback(callbackId, 'Бой уже завершён.', true);
      return;
    }
    if (game.turnUserId !== player.userId) {
      await transport.answerCallback(callbackId, 'Сейчас ход соперника — не жми не в свою очередь!', true);
      return;
    }
    const idx = parseInt(parts[3] || '-1', 10);
    if (idx < 0 || idx > 15) {
      await transport.answerCallback(callbackId);
      return;
    }

    const isA = game.turnUserId === game.sideA.userId;
    const attacker = isA ? game.sideA : game.sideB;
    const defender = isA ? game.sideB : game.sideA;

    if (defender.hitsReceived.includes(idx) || defender.missesReceived.includes(idx)) {
      await transport.answerCallback(callbackId, 'Сюда уже стреляли! Выбери целую волну 🌊.', true);
      return;
    }

    attacker.shotsTaken += 1;
    game.lastActionAt = Date.now();
    const isHit = defender.ships.includes(idx);
    if (isHit) {
      defender.hitsReceived.push(idx);
    } else {
      defender.missesReceived.push(idx);
    }

    // Check if attacker won
    if (defender.hitsReceived.length >= defender.ships.length) {
      game.status = 'finished';
      battleshipGames.delete(gid);
      markRuntimeDirty();

      if (game.mode === 'solo') {
        const mult = getSoloBattleshipMultiplier(game.sideA.shotsTaken);
        const payout = Math.round(game.stake * mult);
        const net = payout - game.stake;
        player.balance += payout;
        player.lastBetAmount = game.stake;
        player.lastGameType = 'battleship';
        player.stats.totalWon += Math.max(0, net);
        if (game.sideA.isLastDodep && player.lastActionWasLoss) {
          player.stats.lastDodepWins += 1;
        }
        player.lastActionWasLoss = false;
        player.lastActionWasLastDodep = false;
        recordGameOutcome(chat, player, 'battleship', net, {
          isAllIn: game.sideA.isAllIn,
          isLastDodep: game.sideA.isLastDodep
        });
        scheduleSave();
        addBotLog({
          source: transport.source,
          chatId: chat.chatId,
          chatTitle: chat.title,
          userName: game.sideA.firstName,
          event: `Морской бой: Победа x${mult.toFixed(1)}`,
          detail: `Потопил флот Деда за ${game.sideA.shotsTaken} выстр. (+${payout} 🪙)`
        });
        await transport.answerCallback(callbackId, `💥 ПОТОПИЛ! Победа x${mult.toFixed(1)} (+${payout} 🪙)!`);
        const lines = [
          `⚓ МОРСКОЙ БОЙ — ПОБЕДА АДМИРАЛА!`,
          `💥 Потоплен весь флот Дяди Депа за ${game.sideA.shotsTaken} выстр.!`,
          `🏆 Множитель: x${mult.toFixed(1)} → +${payout} 🪙 · Баланс: ${player.balance} 🪙`,
          ``,
          `🎯 Поле Деда:`,
          format4x4Ascii(defender, true)
        ];
        await transport.editMessage(
          chat.chatId,
          game.messageId || messageId,
          lines.join('\n'),
          buildPostGameKeyboard('battleship', game.stake, false, player)
        );
        if (net > 0) await applyAutoDebtCollection(transport, chat, player, net);
        return;
      }

      // PvP Win
      const pot = game.stake * 2;
      const winnerPlayer = chat.players[attacker.userId];
      const loserPlayer = chat.players[defender.userId];
      if (winnerPlayer) {
        winnerPlayer.balance += pot;
        winnerPlayer.lastBetAmount = game.stake;
        winnerPlayer.lastGameType = 'battleship';
        winnerPlayer.stats.totalWon += game.stake;
        winnerPlayer.lastActionWasLoss = false;
        recordGameOutcome(chat, winnerPlayer, 'battleship', game.stake, { isAllIn: attacker.isAllIn });
      }
      if (loserPlayer) {
        loserPlayer.lastBetAmount = game.stake;
        loserPlayer.lastGameType = 'battleship';
        loserPlayer.stats.totalLost += game.stake;
        loserPlayer.lastActionWasLoss = true;
        recordGameOutcome(chat, loserPlayer, 'battleship', -game.stake, { isAllIn: defender.isAllIn });
      }
      scheduleSave();
      addBotLog({
        source: transport.source,
        chatId: chat.chatId,
        chatTitle: chat.title,
        userName: attacker.firstName,
        event: 'Морской бой PvP: Победа',
        detail: `${attacker.firstName} потопил ${defender.firstName} · Банк ${pot} 🪙`
      });
      await transport.answerCallback(callbackId, `💥 ПОТОПИЛ! Весь банк ${pot} 🪙 твой!`);
      const lines = [
        `⚓ МОРСКОЙ БОЙ 1×1 — ПОБЕДА!`,
        `🏆 Адмирал ${attacker.firstName} потопил весь флот ${defender.firstName} и забирает банк ${pot} 🪙 (x2)!`,
        ``,
        `🚢 Флот ${game.sideA.firstName}:`,
        format4x4Ascii(game.sideA, true),
        ``,
        `🚢 Флот ${game.sideB.firstName}:`,
        format4x4Ascii(game.sideB, true)
      ];
      await transport.editMessage(
        chat.chatId,
        game.messageId || messageId,
        lines.join('\n'),
        buildPostGameKeyboard('battleship', game.stake, false)
      );
      if (winnerPlayer) await applyAutoDebtCollection(transport, chat, winnerPlayer, game.stake);
      if (loserPlayer && loserPlayer.balance === 0) await maybeSendZeroBalanceOffer(transport, chat, loserPlayer);
      return;
    }

    // In Solo mode: if player missed, Ded gets a shot (if player hit, player keeps firing!)
    if (game.mode === 'solo') {
      if (isHit) {
        game.lastEventText = `💥 ПОПАДАНИЕ! Подбит отсек Деда (${defender.hitsReceived.length}/4). Стреляй ещё!`;
        await transport.answerCallback(callbackId, '💥 Попадание! Твой ход продолжается!');
      } else {
        // Ded fires 1 shot (smart adjacent targeting if already hit a non-sunk area or random unhit)
        const avail: number[] = [];
        for (let i = 0; i < 16; i++) {
          if (!game.sideA.hitsReceived.includes(i) && !game.sideA.missesReceived.includes(i)) {
            avail.push(i);
          }
        }
        const dedShot = avail[Math.floor(Math.random() * avail.length)] ?? 0;
        const dedHit = game.sideA.ships.includes(dedShot);
        if (dedHit) game.sideA.hitsReceived.push(dedShot);
        else game.sideA.missesReceived.push(dedShot);

        if (game.sideA.hitsReceived.length >= game.sideA.ships.length) {
          game.status = 'finished';
          battleshipGames.delete(gid);
          markRuntimeDirty();
          player.lastBetAmount = game.stake;
          player.lastGameType = 'battleship';
          player.stats.totalLost += game.stake;
          player.lastActionWasLoss = true;
          player.lastActionWasLastDodep = false;
          recordGameOutcome(chat, player, 'battleship', -game.stake, {
            isAllIn: game.sideA.isAllIn,
            isLastDodep: game.sideA.isLastDodep
          });
          scheduleSave();
          addBotLog({
            source: transport.source,
            chatId: chat.chatId,
            chatTitle: chat.title,
            userName: game.sideA.firstName,
            event: 'Морской бой: Поражение',
            detail: `Дед потопил флот игрока (-${game.stake} 🪙)`
          });
          await transport.answerCallback(callbackId, '💥 Дед накрыл твой последний корабль!');
          const lines = [
            `⚓ МОРСКОЙ БОЙ — ФЛОТ НА ДНЕ!`,
            `🧔‍♂️ Дядя Деп потопил все твои корабли. Ставка ${game.stake} 🪙 ушла в порт Деда.`,
            `🪙 Баланс: ${player.balance} 🪙`,
            ``,
            `🎯 Поле Деда (осталось ${defender.ships.length - defender.hitsReceived.length} кл.):`,
            format4x4Ascii(defender, true)
          ];
          await transport.editMessage(
            chat.chatId,
            game.messageId || messageId,
            lines.join('\n'),
            buildPostGameKeyboard('battleship', game.stake, true, player)
          );
          if (player.balance === 0) await maybeSendZeroBalanceOffer(transport, chat, player);
          return;
        }

        game.lastEventText = dedHit
          ? `💦 Ты промахнулся! 🔥 Дядя Деп в ответ ПОПАЛ по твоему кораблю (${game.sideA.hitsReceived.length}/4)!`
          : `💦 Оба по воде! Снова твой залп.`;
        await transport.answerCallback(callbackId, dedHit ? '💦 Мимо! Дед попал в ответ!' : '💦 Мимо, Дед тоже мимо!');
      }

      markRuntimeDirty();
      const view = buildBattleshipPlayPayload(game);
      await transport.editMessage(chat.chatId, game.messageId || messageId, view.text, view.keyboard);
      return;
    }

    // PvP: hit = stay on turn, miss = pass turn
    if (isHit) {
      game.lastEventText = `💥 ${attacker.firstName} ПОПАЛ! (${defender.hitsReceived.length}/4) — стреляет ещё!`;
      await transport.answerCallback(callbackId, '💥 Прямое попадание! Стреляй ещё!');
    } else {
      game.turnUserId = defender.userId;
      game.lastEventText = `💦 ${attacker.firstName} ударил мимо! Ход переходит к ${defender.firstName}.`;
      await transport.answerCallback(callbackId, '💦 Мимо! Ход переходит к сопернику.');
    }
    markRuntimeDirty();
    const view = buildBattleshipPlayPayload(game);
    await transport.editMessage(chat.chatId, game.messageId || messageId, view.text, view.keyboard);
    return;
  }

  await transport.answerCallback(callbackId);
}

// =====================================
// GAME #3: CHICKEN DUEL ("КУРИЦА / ТРУСИШКА")
// =====================================

interface ChickenDuel {
  id: string;
  chatId: string;
  stake: number;
  creatorId: string;
  creatorName: string;
  creatorAllIn: boolean;
  creatorLastDodep: boolean;
  opponentId: string | null;
  opponentName: string | null;
  opponentAllIn: boolean;
  step: number; // 1..6
  boomStep: number; // 1..7 (7 = survives all 6 steps!)
  choices: Record<string, 'hold' | 'fold'>;
  status: 'waiting' | 'playing' | 'finished';
  messageId: string | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
  lastActionAt: number;
}

const chickenDuels = new Map<string, ChickenDuel>();

const CHICKEN_STEP_MULTS = [1.0, 1.15, 1.4, 1.8, 2.45, 3.5, 5.0];

function rollChickenBoomStep(): number {
  const survivals = [0.88, 0.82, 0.76, 0.7, 0.65, 0.6];
  for (let s = 1; s <= 6; s++) {
    if (Math.random() > survivals[s - 1]) return s;
  }
  return 7; // Survived all 6 steps -> Jackpot x5.0!
}

function buildChickenPayload(duel: ChickenDuel): { text: string; keyboard: InlineKeyboard } {
  if (duel.status === 'waiting') {
    const lines = [
      `🐔 КУРИЦА / ТРУСИШКА 1×1 — ВЫЗОВ!`,
      `👤 Зачинщик: ${duel.creatorName} · Ставка: ${duel.stake} 🪙`,
      ``,
      `В каждом раунде оба тайно выбирают: «🔥 Жать дальше» или «🐔 Струсить».`,
      `Струсишь один — заберёшь долю, но смелый заберёт больше. Пережмут оба — сгорят оба! Дотянули до финиша — x5 каждому!`
    ];
    return {
      text: lines.join('\n'),
      keyboard: [
        [{ text: `🐔 Принять дуэль (${duel.stake} 🪙)`, callbackData: `chk:join:${duel.id}` }],
        [{ text: '❌ Отменить вызов', callbackData: `chk:cancel:${duel.id}` }]
      ]
    };
  }

  const curMult = CHICKEN_STEP_MULTS[Math.min(6, duel.step)] || 1.15;
  const foldShare = Math.round(duel.stake * (0.65 + (duel.step - 1) * 0.15));
  const braveShare = Math.round(duel.stake * (1.35 + (duel.step - 1) * 0.35));
  const cDone = Boolean(duel.choices[duel.creatorId]);
  const oDone = Boolean(duel.opponentId && duel.choices[duel.opponentId]);
  const meter = '🔥'.repeat(duel.step) + '⬜'.repeat(Math.max(0, 6 - duel.step));

  const lines = [
    `🐔 КУРИЦА / ТРУСИШКА — РАУНД ${duel.step}/6`,
    `⚡ Напряжение: [${meter}] (Банк x${curMult.toFixed(2)})`,
    ``,
    `• ${cDone ? '✅' : '⏳'} ${duel.creatorName}`,
    `• ${oDone ? '✅' : '⏳'} ${duel.opponentName}`,
    ``,
    `📊 Сейчас на кону (ставка ${duel.stake} 🪙):`,
    `• Если один струсит: трус +${foldShare} 🪙, смельчак +${braveShare} 🪙`,
    `• Если струсят оба: оба по +${Math.round(duel.stake * (0.9 + (duel.step - 1) * 0.12))} 🪙`,
    `• Финиш после 6 раунда: джекпот x5 (${duel.stake * 5} 🪙 каждому)!`
  ];

  const kb: InlineKeyboard = [
    [
      { text: '🔥 Жать дальше!', callbackData: `chk:act:${duel.id}:hold` },
      { text: `🐔 Струсить (${foldShare} 🪙)`, callbackData: `chk:act:${duel.id}:fold` }
    ]
  ];
  return { text: lines.join('\n'), keyboard: kb };
}

export async function startChickenDuel(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  stake: number,
  isLastDodep: boolean,
  messageId?: string
): Promise<void> {
  const isAllIn = deductPlayerStake(player, stake);
  scheduleSave();

  const id = shortId();
  const duel: ChickenDuel = {
    id,
    chatId: chat.chatId,
    stake,
    creatorId: player.userId,
    creatorName: displayName(player),
    creatorAllIn: isAllIn,
    creatorLastDodep: isLastDodep,
    opponentId: null,
    opponentName: null,
    opponentAllIn: false,
    step: 1,
    boomStep: rollChickenBoomStep(),
    choices: {},
    status: 'waiting',
    messageId: messageId || null,
    transportSource: transport.source,
    transport,
    createdAt: Date.now(),
    lastActionAt: Date.now()
  };
  chickenDuels.set(id, duel);
  markRuntimeDirty();

  const view = buildChickenPayload(duel);
  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    duel.messageId = messageId;
  } else {
    duel.messageId = await transport.sendMessage(chat.chatId, view.text, view.keyboard);
  }
}

export async function handleChickenCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];
  const did = parts[2];
  const duel = chickenDuels.get(did);
  if (!duel) {
    await transport.answerCallback(callbackId, 'Эта дуэль уже завершилась.', true);
    return;
  }

  if (sub === 'cancel') {
    if (duel.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Дуэль уже в разгаре!', true);
      return;
    }
    if (duel.creatorId !== player.userId) {
      await transport.answerCallback(callbackId, 'Отменить вызов может только создатель!', true);
      return;
    }
    duel.status = 'finished';
    chickenDuels.delete(did);
    markRuntimeDirty();
    const creator = chat.players[duel.creatorId];
    if (creator) creator.balance += duel.stake;
    scheduleSave();
    await transport.answerCallback(callbackId, 'Вызов отменён.');
    await transport.editMessage(
      chat.chatId,
      duel.messageId || messageId,
      `❌ Дуэль «Курица» отменена создателем. Ставка ${duel.stake} 🪙 возвращена.`,
      [[{ text: '🏠 В меню', callbackData: 'menu' }]]
    );
    return;
  }

  if (sub === 'join') {
    if (duel.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Соперник уже найден!', true);
      return;
    }
    if (duel.creatorId === player.userId) {
      await transport.answerCallback(callbackId, 'С самим собой нервы не пощекочешь — жди соперника!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    if (player.balance < duel.stake) {
      await transport.answerCallback(callbackId, `Нужно ${duel.stake} 🪙 (у тебя ${player.balance} 🪙)!`, true);
      return;
    }

    duel.opponentAllIn = deductPlayerStake(player, duel.stake);
    duel.opponentId = player.userId;
    duel.opponentName = displayName(player);
    duel.status = 'playing';
    duel.lastActionAt = Date.now();
    markRuntimeDirty();
    scheduleSave();

    await transport.answerCallback(callbackId, '🔥 Вызов принят! Делайте первый выбор!');
    const view = buildChickenPayload(duel);
    await transport.editMessage(chat.chatId, duel.messageId || messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'act') {
    if (duel.status !== 'playing' || !duel.opponentId) {
      await transport.answerCallback(callbackId, 'Дуэль уже окончена.', true);
      return;
    }
    if (player.userId !== duel.creatorId && player.userId !== duel.opponentId) {
      await transport.answerCallback(callbackId, 'Это дуэль двух других кентов!', true);
      return;
    }
    if (duel.choices[player.userId]) {
      await transport.answerCallback(callbackId, 'Ты уже выбрал в этом раунде! Ждём второго игрока.', true);
      return;
    }

    const choice = parts[3] === 'fold' ? 'fold' : 'hold';
    duel.choices[player.userId] = choice;
    duel.lastActionAt = Date.now();

    const cChoice = duel.choices[duel.creatorId];
    const oChoice = duel.choices[duel.opponentId];
    if (!cChoice || !oChoice) {
      markRuntimeDirty();
      await transport.answerCallback(
        callbackId,
        choice === 'fold' ? '🐔 Ты выбрал струсить! Ждём соперника...' : '🔥 Ты жмёшь газ! Ждём соперника...'
      );
      const view = buildChickenPayload(duel);
      await transport.editMessage(chat.chatId, duel.messageId || messageId, view.text, view.keyboard);
      return;
    }

    // Both players made their choice!
    const pA = chat.players[duel.creatorId];
    const pB = chat.players[duel.opponentId];

    const settlePlayers = async (payA: number, payB: number, headline: string, subline: string) => {
      duel.status = 'finished';
      chickenDuels.delete(did);
      markRuntimeDirty();

      const applyOutcome = (ps: PlayerState | undefined, pay: number, allIn: boolean, ld: boolean) => {
        if (!ps) return;
        ps.balance += pay;
        ps.lastBetAmount = duel.stake;
        ps.lastGameType = 'chicken';
        const net = pay - duel.stake;
        if (net > 0) {
          ps.stats.totalWon += net;
          if (ld && ps.lastActionWasLoss) ps.stats.lastDodepWins += 1;
          ps.lastActionWasLoss = false;
        } else if (net < 0) {
          ps.stats.totalLost += Math.abs(net);
          ps.lastActionWasLoss = true;
        } else {
          ps.lastActionWasLoss = false;
        }
        ps.lastActionWasLastDodep = false;
        recordGameOutcome(chat, ps, 'chicken', net, { isAllIn: allIn, isLastDodep: ld });
      };

      applyOutcome(pA, payA, duel.creatorAllIn, duel.creatorLastDodep);
      applyOutcome(pB, payB, duel.opponentAllIn, false);
      scheduleSave();

      addBotLog({
        source: transport.source,
        chatId: chat.chatId,
        chatTitle: chat.title,
        event: `Курица 1×1: Раунд ${duel.step}`,
        detail: `${duel.creatorName} (${payA} 🪙) vs ${duel.opponentName} (${payB} 🪙)`
      });

      const lines = [
        headline,
        subline,
        ``,
        `• ${duel.creatorName}: ${cChoice === 'fold' ? '🐔 Струсил' : '🔥 Жал'} → получил ${payA} 🪙`,
        `• ${duel.opponentName}: ${oChoice === 'fold' ? '🐔 Струсил' : '🔥 Жал'} → получил ${payB} 🪙`
      ];
      await transport.answerCallback(callbackId, '🔥 Раунд вскрыт!');
      await transport.editMessage(
        chat.chatId,
        duel.messageId || messageId,
        lines.join('\n'),
        buildPostGameKeyboard('chicken', duel.stake, payA === 0 || payB === 0)
      );
      if (pA && payA - duel.stake > 0) await applyAutoDebtCollection(transport, chat, pA, payA - duel.stake);
      if (pB && payB - duel.stake > 0) await applyAutoDebtCollection(transport, chat, pB, payB - duel.stake);
      if (pA && pA.balance === 0) await maybeSendZeroBalanceOffer(transport, chat, pA);
      if (pB && pB.balance === 0) await maybeSendZeroBalanceOffer(transport, chat, pB);
    };

    if (cChoice === 'fold' && oChoice === 'fold') {
      const each = Math.round(duel.stake * (0.9 + (duel.step - 1) * 0.12));
      await settlePlayers(
        each,
        each,
        `🐔🐔 ОБА СТРУСИЛИ НА РАУНДЕ ${duel.step}!`,
        `Нервы не железные — оба забирают по ${each} 🪙.`
      );
      return;
    }

    if (cChoice !== oChoice) {
      const foldShare = Math.round(duel.stake * (0.65 + (duel.step - 1) * 0.15));
      const braveShare = Math.round(duel.stake * (1.35 + (duel.step - 1) * 0.35));
      const payA = cChoice === 'fold' ? foldShare : braveShare;
      const payB = oChoice === 'fold' ? foldShare : braveShare;
      const braveName = cChoice === 'hold' ? duel.creatorName : duel.opponentName!;
      await settlePlayers(
        payA,
        payB,
        `🐔 ОДИН СТРУСИЛ — ${braveName} ДОЖАЛ!`,
        `На раунде ${duel.step} смельчак забирает жирный куш ${braveShare} 🪙!`
      );
      return;
    }

    // Both held! Check explosion
    if (duel.step >= duel.boomStep) {
      await settlePlayers(
        0,
        0,
        `💥 БАБАХ НА РАУНДЕ ${duel.step}! ОБА ПЕРЕЖАРИЛИ!`,
        `Никто не нажал «Струсить» — весь банк сгорел дотла!`
      );
      return;
    }

    if (duel.step >= 6) {
      const jackpot = duel.stake * 5;
      await settlePlayers(
        jackpot,
        jackpot,
        `🏆 СТАЛЬНЫЕ НЕРВЫ! ОБА ПРОШЛИ ВСЕ 6 РАУНДОВ!`,
        `Абсолютный финиш — каждому достаётся джекпот x5 (${jackpot} 🪙)!`
      );
      return;
    }

    // Advance to next step
    duel.step += 1;
    duel.choices = {};
    markRuntimeDirty();
    await transport.answerCallback(callbackId, `🔥 ПРОНЕСЛО! Переход на раунд ${duel.step}/6!`);
    const view = buildChickenPayload(duel);
    await transport.editMessage(chat.chatId, duel.messageId || messageId, view.text, view.keyboard);
    return;
  }

  await transport.answerCallback(callbackId);
}

// =====================================
// GAME #4: BLIND AUCTION ("ТЁМНЫЙ АУКЦИОН — СЛЕПОЙ ЛОТ")
// =====================================

interface BlindLot {
  id: string;
  chatId: string;
  clue: string;
  baseBid: number;
  currentBid: number;
  highestBidderId: string;
  highestBidderName: string;
  bidders: string[]; // unique userIds
  bidsCount: number;
  mysteryMult: number; // hidden multiplier anchored to baseBid
  bonusTalisman: boolean;
  status: 'active' | 'finished';
  messageId: string | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
  endsAt: number;
}

const blindLots = new Map<string, BlindLot>();

const BLIND_CLUES = [
  '📦 «Тяжёлый дипломат с кодовым замком из подсобки»',
  '🧥 «Старый пиджак авторитета (в кармане что-то звенит)»',
  '🧰 «Запечатанный сейф-чемоданчик ночного сменщика»',
  '🎩 «Шляпа фокусника с двойным дном»',
  '🗃 «Архивная коробка с печатью “Додеп 1999”»'
];

function rollBlindLotSecret(hasCompetition: boolean): { mult: number; bonusTalisman: boolean } {
  const r = Math.random();
  // Balanced EV (~0.96 solo, higher with competition bonus added at settlement)
  if (r < 0.16) return { mult: 0.15 + Math.random() * 0.2, bonusTalisman: false }; // 16% Sock / junk
  if (r < 0.52) return { mult: 0.7 + Math.random() * 0.45, bonusTalisman: false }; // 36% Small bills
  if (r < 0.84) return { mult: 1.2 + Math.random() * 0.7, bonusTalisman: false }; // 32% Nice stash
  if (r < 0.95) return { mult: 2.1 + Math.random() * 1.1, bonusTalisman: false }; // 11% Gold bar
  return {
    mult: hasCompetition ? 3.2 : 2.6,
    bonusTalisman: true // 5% Jackpot + Talisman!
  };
}

function buildBlindAuctionPayload(lot: BlindLot): { text: string; keyboard: InlineKeyboard } {
  const leftSec = Math.max(0, Math.ceil((lot.endsAt - Date.now()) / 1000));
  const stepSmall = Math.max(25, Math.round(lot.baseBid * 0.25));
  const stepMed = Math.max(50, Math.round(lot.baseBid * 0.5));
  const stepBig = Math.max(100, lot.baseBid);
  const compBonusPct = Math.max(0, (lot.bidders.length - 1) * 15);

  const lines = [
    `🎁 ТЁМНЫЙ АУКЦИОН (СЛЕПОЙ ЛОТ)`,
    lot.clue,
    ``,
    `🔨 Текущая ставка: ${lot.currentBid} 🪙 (база ${lot.baseBid} 🪙)`,
    `👑 Лидер торгов: ${lot.highestBidderName}`,
    `👥 Участников: ${lot.bidders.length} · Заявок: ${lot.bidsCount}${compBonusPct > 0 ? ` · Бонус азарта: +${compBonusPct}% к кладу!` : ''}`,
    `⏱ До удара молотка: ~${leftSec} сек`,
    ``,
    `Внутри может быть от дырявого носка (x0.2) до слитка (x4.0) и редкого талисмана!`
  ];

  const kb: InlineKeyboard = [
    [
      { text: `+${stepSmall} 🪙`, callbackData: `bau:bid:${lot.id}:${stepSmall}` },
      { text: `+${stepMed} 🪙`, callbackData: `bau:bid:${lot.id}:${stepMed}` },
      { text: `+${stepBig} 🪙`, callbackData: `bau:bid:${lot.id}:${stepBig}` }
    ],
    [
      { text: '🔨 Вскрыть лот!', callbackData: `bau:settle:${lot.id}` },
      { text: '🔄 Обновить', callbackData: `bau:refresh:${lot.id}` }
    ]
  ];
  return { text: lines.join('\n'), keyboard: kb };
}

async function settleBlindAuction(chat: ChatState, lot: BlindLot): Promise<void> {
  if (lot.status === 'finished') return;
  lot.status = 'finished';
  blindLots.delete(lot.id);
  markRuntimeDirty();

  const winner = chat.players[lot.highestBidderId];
  const compBoost = 1 + Math.max(0, (lot.bidders.length - 1) * 0.15);
  const rewardCoins = Math.max(10, Math.round(lot.baseBid * lot.mysteryMult * compBoost));

  let talismanLine = '';
  if (winner && lot.bonusTalisman) {
    const rarity = Math.random() < 0.35 ? 'epic' : 'rare';
    const pool = getTalismansByRarity(rarity);
    if (pool.length > 0) {
      const picked = pool[Math.floor(Math.random() * pool.length)];
      const inst: OwnedTalisman = {
        instanceId: `tl-${shortId()}`,
        talismanId: picked.id,
        obtainedAt: Date.now()
      };
      if (!winner.talismans) winner.talismans = [];
      winner.talismans.push(inst);
      talismanLine = `\n🏅 СЮРПРИЗ ВНУТРИ: ${picked.emoji} ${picked.name} (${RARITY_META[rarity].label})!`;
    }
  }

  let verdictTitle = '';
  if (lot.mysteryMult < 0.5) verdictTitle = '🧦 ОЙ! Внутри оказался дырявый носок и сдача!';
  else if (lot.mysteryMult < 1.15) verdictTitle = '💵 Внутри скромная пачка мятых купюр!';
  else if (lot.mysteryMult < 2.0) verdictTitle = '💰 ОТЛИЧНО! Сейфовая заначка!';
  else verdictTitle = '💎 КУШ! ЗОЛОТОЙ СЛИТОК ДЯДИ ДЕПА!';

  if (winner) {
    winner.balance += rewardCoins;
    winner.lastBetAmount = lot.currentBid;
    winner.lastGameType = 'blindauc';
    const net = rewardCoins - lot.currentBid;
    if (net >= 0) {
      winner.stats.totalWon += net;
      winner.lastActionWasLoss = false;
    } else {
      winner.stats.totalLost += Math.abs(net);
      winner.lastActionWasLoss = true;
    }
    recordGameOutcome(chat, winner, 'blindauc', net);
  }
  scheduleSave();

  const tr = getPartyTransport(lot.transportSource, chat.chatId, lot.transport);
  addBotLog({
    source: tr?.source || 'telegram',
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: lot.highestBidderName,
    event: `Тёмный аукцион: лот вскрыт`,
    detail: `${lot.highestBidderName} взял за ${lot.currentBid} 🪙 → внутри ${rewardCoins} 🪙`
  });

  const net = rewardCoins - lot.currentBid;
  const diffStr = net >= 0 ? `профит +${net} 🪙` : `минус ${net} 🪙`;
  const lines = [
    `🔨 МОЛОТОК УДАРИЛ — ТЁМНЫЙ ЛОТ ВСКРЫТ!`,
    lot.clue,
    ``,
    verdictTitle,
    `👑 Победитель: ${lot.highestBidderName} (забрал за ${lot.currentBid} 🪙)`,
    `💎 Внутри оказалось: ${rewardCoins} 🪙 (${diffStr})${talismanLine}`
  ];

  if (tr) {
    const kb = buildPostGameKeyboard('blindauc', lot.baseBid, net < 0);
    if (lot.messageId) {
      await tr.editMessage(chat.chatId, lot.messageId, lines.join('\n'), kb);
    } else {
      await tr.sendMessage(chat.chatId, lines.join('\n'), kb);
    }
    if (winner && net > 0) await applyAutoDebtCollection(tr, chat, winner, net);
    if (winner && winner.balance === 0) await maybeSendZeroBalanceOffer(tr, chat, winner);
  }
}

export async function startBlindAuction(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  stake: number,
  messageId?: string
): Promise<void> {
  deductPlayerStake(player, stake);
  scheduleSave();

  const secret = rollBlindLotSecret(false);
  const id = shortId();
  const lot: BlindLot = {
    id,
    chatId: chat.chatId,
    clue: BLIND_CLUES[Math.floor(Math.random() * BLIND_CLUES.length)],
    baseBid: stake,
    currentBid: stake,
    highestBidderId: player.userId,
    highestBidderName: displayName(player),
    bidders: [player.userId],
    bidsCount: 1,
    mysteryMult: secret.mult,
    bonusTalisman: secret.bonusTalisman,
    status: 'active',
    messageId: messageId || null,
    transportSource: transport.source,
    transport,
    createdAt: Date.now(),
    endsAt: Date.now() + 50_000
  };
  blindLots.set(id, lot);
  markRuntimeDirty();

  const view = buildBlindAuctionPayload(lot);
  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    lot.messageId = messageId;
  } else {
    lot.messageId = await transport.sendMessage(chat.chatId, view.text, view.keyboard);
  }
}

export async function handleBlindAuctionCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];
  const lid = parts[2];
  const lot = blindLots.get(lid);
  if (!lot) {
    await transport.answerCallback(callbackId, 'Этот лот уже вскрыт и продан!', true);
    return;
  }

  if (Date.now() >= lot.endsAt && sub !== 'settle') {
    await transport.answerCallback(callbackId, '🔨 Время торгов вышло — вскрываем!');
    await settleBlindAuction(chat, lot);
    return;
  }

  if (sub === 'refresh') {
    await transport.answerCallback(callbackId, 'Таймер обновлён.');
    const view = buildBlindAuctionPayload(lot);
    await transport.editMessage(chat.chatId, lot.messageId || messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'settle') {
    const elapsed = Date.now() - lot.createdAt;
    if (lot.bidders.length < 2 && elapsed < 8000 && lot.highestBidderId === player.userId) {
      await transport.answerCallback(
        callbackId,
        `Дай чату хотя бы ${Math.ceil((8000 - elapsed) / 1000)} сек перебить лот (или вскрой позже)!`,
        true
      );
      return;
    }
    if (!lot.bidders.includes(player.userId)) {
      await transport.answerCallback(callbackId, 'Вскрыть лот может участник торгов!', true);
      return;
    }
    await transport.answerCallback(callbackId, '🔨 Молот! Вскрываем лот!');
    await settleBlindAuction(chat, lot);
    return;
  }

  if (sub === 'bid') {
    const inc = parseInt(parts[3] || '50', 10);
    if (!Number.isFinite(inc) || inc <= 0) {
      await transport.answerCallback(callbackId);
      return;
    }
    if (lot.highestBidderId === player.userId) {
      await transport.answerCallback(callbackId, 'Твоя ставка и так лидирует! Не перебивай сам себя.', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    const newBid = lot.currentBid + inc;
    if (player.balance < newBid) {
      await transport.answerCallback(callbackId, `Для ставки ${newBid} 🪙 не хватает фантиков (баланс ${player.balance} 🪙)!`, true);
      return;
    }

    // Refund previous highest bidder immediately
    const prevWinner = chat.players[lot.highestBidderId];
    if (prevWinner) {
      prevWinner.balance += lot.currentBid;
    }
    deductPlayerStake(player, newBid);

    lot.currentBid = newBid;
    lot.highestBidderId = player.userId;
    lot.highestBidderName = displayName(player);
    lot.bidsCount += 1;
    if (!lot.bidders.includes(player.userId)) {
      lot.bidders.push(player.userId);
    }
    // Extend sniping window slightly
    lot.endsAt = Math.max(lot.endsAt, Date.now() + 15_000);
    markRuntimeDirty();
    scheduleSave();

    await transport.answerCallback(callbackId, `🔨 Ставка ${newBid} 🪙 принята! Предыдущему лидеру сделан возврат.`);
    const view = buildBlindAuctionPayload(lot);
    await transport.editMessage(chat.chatId, lot.messageId || messageId, view.text, view.keyboard);
    return;
  }

  await transport.answerCallback(callbackId);
}

// =====================================
// GAME #6: LIAR'S DICE ("ВЕРЮ — НЕ ВЕРЮ" · 2–4 ИГРОКА)
// =====================================

interface LiarsSeat {
  userId: string;
  firstName: string;
  dice: number[]; // 3 secret dice (1..6)
  isAllIn: boolean;
  isLastDodep: boolean;
}

interface LiarsDiceGame {
  id: string;
  chatId: string;
  stake: number;
  creatorId: string;
  seats: LiarsSeat[];
  turnIndex: number;
  currentQty: number;
  currentFace: number; // 1..6
  lastBidderId: string | null;
  lastBidderName: string | null;
  status: 'waiting' | 'playing' | 'finished';
  messageId: string | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
  lastActionAt: number;
}

const liarsGames = new Map<string, LiarsDiceGame>();

const DIE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

function roll3Dice(): number[] {
  return [
    Math.floor(Math.random() * 6) + 1,
    Math.floor(Math.random() * 6) + 1,
    Math.floor(Math.random() * 6) + 1
  ].sort((a, b) => a - b);
}

function buildLiarsPayload(game: LiarsDiceGame): { text: string; keyboard: InlineKeyboard } {
  if (game.status === 'waiting') {
    const pot = game.stake * game.seats.length;
    const lines = [
      `🎲 ВЕРЮ — НЕ ВЕРЮ (БЛЕФ НА КОСТЯХ · 2–4 ИГРОКА)`,
      `🪙 Ставка: ${game.stake} 🪙 · Банк: ${pot} 🪙 · У каждого по 3 скрытые кости`,
      ``,
      `👥 За столом (${game.seats.length}/4):`,
      ...game.seats.map((s, idx) => `${idx + 1}. ${s.firstName}`)
    ];
    const kb: InlineKeyboard = [
      [{ text: `🪑 Сесть за стол (${game.stake} 🪙)`, callbackData: `ldc:join:${game.id}` }],
      [
        ...(game.seats.length >= 2 ? [{ text: '🎲 Раздать кости!', callbackData: `ldc:start:${game.id}` }] : []),
        { text: '❌ Отменить стол', callbackData: `ldc:cancel:${game.id}` }
      ]
    ];
    return { text: lines.join('\n'), keyboard: kb };
  }

  const totalDice = game.seats.length * 3;
  const activeSeat = game.seats[game.turnIndex % game.seats.length];
  const pot = game.stake * game.seats.length;
  const bidLine =
    game.currentQty > 0
      ? `📢 Текущая заявка (${game.lastBidderName}): «минимум ${game.currentQty}× ${DIE_FACES[game.currentFace]} (${game.currentFace}) на столе!»`
      : `📢 Заявка пока пустая — делай первый прогноз!`;

  const lines = [
    `🎲 ВЕРЮ — НЕ ВЕРЮ · БАНК ${pot} 🪙 (Всего костей: ${totalDice})`,
    bidLine,
    ``,
    `👉 Ход игрока: ${activeSeat.firstName}`,
    `Участники: ${game.seats.map((s) => (s.userId === activeSeat.userId ? `▶️ ${s.firstName}` : s.firstName)).join(' · ')}`,
    ``,
    `Жми «🫣 Мои кости», чтобы тайно посмотреть свои 3 кубика!`
  ];

  const kb: InlineKeyboard = [];
  kb.push([{ text: '🫣 Мои кости (секрет)', callbackData: `ldc:peek:${game.id}` }]);

  if (game.currentQty === 0) {
    kb.push([
      { text: '1×⚀', callbackData: `ldc:bid:${game.id}:1:1` },
      { text: '1×⚁', callbackData: `ldc:bid:${game.id}:1:2` },
      { text: '1×⚂', callbackData: `ldc:bid:${game.id}:1:3` },
      { text: '1×⚃', callbackData: `ldc:bid:${game.id}:1:4` },
      { text: '1×⚄', callbackData: `ldc:bid:${game.id}:1:5` },
      { text: '1×⚅', callbackData: `ldc:bid:${game.id}:1:6` }
    ]);
    kb.push([
      { text: '2×⚁', callbackData: `ldc:bid:${game.id}:2:2` },
      { text: '2×⚃', callbackData: `ldc:bid:${game.id}:2:4` },
      { text: '2×⚅', callbackData: `ldc:bid:${game.id}:2:6` }
    ]);
  } else {
    // Higher face at same qty (if face < 6)
    const sameQtyRow: InlineButton[] = [];
    for (let f = game.currentFace + 1; f <= 6; f++) {
      sameQtyRow.push({
        text: `${game.currentQty}×${DIE_FACES[f]}`,
        callbackData: `ldc:bid:${game.id}:${game.currentQty}:${f}`
      });
    }
    if (sameQtyRow.length > 0) kb.push(sameQtyRow);

    // Next qty (currentQty + 1) across all 6 faces
    const nextQty = Math.min(totalDice, game.currentQty + 1);
    if (nextQty > game.currentQty) {
      kb.push([
        { text: `${nextQty}×⚀`, callbackData: `ldc:bid:${game.id}:${nextQty}:1` },
        { text: `${nextQty}×⚁`, callbackData: `ldc:bid:${game.id}:${nextQty}:2` },
        { text: `${nextQty}×⚂`, callbackData: `ldc:bid:${game.id}:${nextQty}:3` }
      ]);
      kb.push([
        { text: `${nextQty}×⚃`, callbackData: `ldc:bid:${game.id}:${nextQty}:4` },
        { text: `${nextQty}×⚄`, callbackData: `ldc:bid:${game.id}:${nextQty}:5` },
        { text: `${nextQty}×⚅`, callbackData: `ldc:bid:${game.id}:${nextQty}:6` }
      ]);
    }

    kb.push([{ text: '🔍 НЕ ВЕРЮ! ВСКРЫВАЕМ!', callbackData: `ldc:call:${game.id}` }]);
  }

  return { text: lines.join('\n'), keyboard: kb };
}

export async function startLiarsDiceLobby(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  stake: number,
  isLastDodep: boolean,
  messageId?: string
): Promise<void> {
  const isAllIn = deductPlayerStake(player, stake);
  scheduleSave();

  const id = shortId();
  const game: LiarsDiceGame = {
    id,
    chatId: chat.chatId,
    stake,
    creatorId: player.userId,
    seats: [
      {
        userId: player.userId,
        firstName: displayName(player),
        dice: roll3Dice(),
        isAllIn,
        isLastDodep
      }
    ],
    turnIndex: 0,
    currentQty: 0,
    currentFace: 0,
    lastBidderId: null,
    lastBidderName: null,
    status: 'waiting',
    messageId: messageId || null,
    transportSource: transport.source,
    transport,
    createdAt: Date.now(),
    lastActionAt: Date.now()
  };
  liarsGames.set(id, game);
  markRuntimeDirty();

  const view = buildLiarsPayload(game);
  if (messageId) {
    await transport.editMessage(chat.chatId, messageId, view.text, view.keyboard);
    game.messageId = messageId;
  } else {
    game.messageId = await transport.sendMessage(chat.chatId, view.text, view.keyboard);
  }
}

export async function handleLiarsDiceCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];
  const gid = parts[2];
  const game = liarsGames.get(gid);
  if (!game) {
    await transport.answerCallback(callbackId, 'Этот стол уже закрыт.', true);
    return;
  }

  if (sub === 'cancel') {
    if (game.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Кости уже розданы!', true);
      return;
    }
    if (game.creatorId !== player.userId) {
      await transport.answerCallback(callbackId, 'Отменить стол может только создатель!', true);
      return;
    }
    game.status = 'finished';
    liarsGames.delete(gid);
    markRuntimeDirty();
    for (const s of game.seats) {
      const ps = chat.players[s.userId];
      if (ps) ps.balance += game.stake;
    }
    scheduleSave();
    await transport.answerCallback(callbackId, 'Стол отменён, ставки возвращены.');
    await transport.editMessage(
      chat.chatId,
      game.messageId || messageId,
      `❌ Стол «Верю — Не верю» отменён. Ставки возвращены (${game.seats.length} чел.).`,
      [[{ text: '🏠 В меню', callbackData: 'menu' }]]
    );
    return;
  }

  if (sub === 'join') {
    if (game.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Раздача уже идёт!', true);
      return;
    }
    if (game.seats.some((s) => s.userId === player.userId)) {
      await transport.answerCallback(callbackId, 'Ты уже за этим столом!', true);
      return;
    }
    if (game.seats.length >= 4) {
      await transport.answerCallback(callbackId, 'За столом уже максимум (4 игрока)!', true);
      return;
    }
    const ghostMs = getGhostRemainingMs(player);
    if (ghostMs > 0) {
      await transport.answerCallback(callbackId, `👻 Призрак чата ещё ${formatDuration(ghostMs)}!`, true);
      return;
    }
    if (player.balance < game.stake) {
      await transport.answerCallback(callbackId, `Нужно ${game.stake} 🪙 (у тебя ${player.balance} 🪙)!`, true);
      return;
    }

    const isAllIn = deductPlayerStake(player, game.stake);
    game.seats.push({
      userId: player.userId,
      firstName: displayName(player),
      dice: roll3Dice(),
      isAllIn,
      isLastDodep: false
    });
    game.lastActionAt = Date.now();
    if (game.seats.length === 4) {
      game.status = 'playing';
    }
    markRuntimeDirty();
    scheduleSave();

    await transport.answerCallback(
      callbackId,
      game.status === 'playing' ? '🎲 Стол полон — начинаем! Смотри свои кости кнопкой!' : '🪑 Ты сел за стол!'
    );
    const view = buildLiarsPayload(game);
    await transport.editMessage(chat.chatId, game.messageId || messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'start') {
    if (game.status !== 'waiting') {
      await transport.answerCallback(callbackId, 'Игра уже идёт!', true);
      return;
    }
    if (game.seats.length < 2) {
      await transport.answerCallback(callbackId, 'Нужно минимум 2 игрока!', true);
      return;
    }
    if (!game.seats.some((s) => s.userId === player.userId)) {
      await transport.answerCallback(callbackId, 'Запустить может участник стола!', true);
      return;
    }
    game.status = 'playing';
    game.turnIndex = 0;
    game.lastActionAt = Date.now();
    markRuntimeDirty();
    await transport.answerCallback(callbackId, '🎲 Кости розданы! Нажмите «Мои кости»!');
    const view = buildLiarsPayload(game);
    await transport.editMessage(chat.chatId, game.messageId || messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'peek') {
    const seat = game.seats.find((s) => s.userId === player.userId);
    if (!seat) {
      await transport.answerCallback(callbackId, 'Ты не сидишь за этим столом!', true);
      return;
    }
    const diceStr = seat.dice.map((d) => `${DIE_FACES[d]}(${d})`).join(' · ');
    await transport.answerCallback(callbackId, `🎲 Твои скрытые кости:\n${diceStr}`, true);
    return;
  }

  if (game.status !== 'playing') {
    await transport.answerCallback(callbackId, 'Эта партия уже завершена.', true);
    return;
  }

  const activeSeat = game.seats[game.turnIndex % game.seats.length];
  if (activeSeat.userId !== player.userId) {
    await transport.answerCallback(callbackId, `Сейчас ход игрока ${activeSeat.firstName}!`, true);
    return;
  }

  if (sub === 'bid') {
    const qty = parseInt(parts[3] || '1', 10);
    const face = parseInt(parts[4] || '1', 10);
    if (face < 1 || face > 6 || qty < 1) {
      await transport.answerCallback(callbackId);
      return;
    }
    const validRaise =
      game.currentQty === 0 ||
      qty > game.currentQty ||
      (qty === game.currentQty && face > game.currentFace);
    if (!validRaise) {
      await transport.answerCallback(callbackId, 'Нужно повысить количество или номинал кубика!', true);
      return;
    }

    game.currentQty = qty;
    game.currentFace = face;
    game.lastBidderId = activeSeat.userId;
    game.lastBidderName = activeSeat.firstName;
    game.turnIndex = (game.turnIndex + 1) % game.seats.length;
    game.lastActionAt = Date.now();
    markRuntimeDirty();

    await transport.answerCallback(callbackId, `📢 Заявка принята: ${qty}× ${DIE_FACES[face]}`);
    const view = buildLiarsPayload(game);
    await transport.editMessage(chat.chatId, game.messageId || messageId, view.text, view.keyboard);
    return;
  }

  if (sub === 'call') {
    if (game.currentQty === 0 || !game.lastBidderId) {
      await transport.answerCallback(callbackId, 'Ещё никто не сделал заявку!', true);
      return;
    }

    game.status = 'finished';
    liarsGames.delete(gid);
    markRuntimeDirty();

    const actualCount = game.seats.reduce(
      (sum, s) => sum + s.dice.filter((d) => d === game.currentFace).length,
      0
    );
    const bidWasTrue = actualCount >= game.currentQty;
    // If bid was true, caller loses; if bluff, previous bidder loses!
    const loserId = bidWasTrue ? activeSeat.userId : game.lastBidderId;
    const loserSeat = game.seats.find((s) => s.userId === loserId)!;
    const winners = game.seats.filter((s) => s.userId !== loserId);
    const pot = game.stake * game.seats.length;
    const share = Math.floor(pot / Math.max(1, winners.length));

    for (const w of winners) {
      const ps = chat.players[w.userId];
      if (!ps) continue;
      ps.balance += share;
      ps.lastBetAmount = game.stake;
      ps.lastGameType = 'liarsdice';
      const net = share - game.stake;
      ps.stats.totalWon += Math.max(0, net);
      if (w.isLastDodep && ps.lastActionWasLoss) ps.stats.lastDodepWins += 1;
      ps.lastActionWasLoss = false;
      ps.lastActionWasLastDodep = false;
      recordGameOutcome(chat, ps, 'liarsdice', net, { isAllIn: w.isAllIn, isLastDodep: w.isLastDodep });
    }

    const loserPs = chat.players[loserSeat.userId];
    if (loserPs) {
      loserPs.lastBetAmount = game.stake;
      loserPs.lastGameType = 'liarsdice';
      loserPs.stats.totalLost += game.stake;
      loserPs.lastActionWasLoss = true;
      loserPs.lastActionWasLastDodep = false;
      recordGameOutcome(chat, loserPs, 'liarsdice', -game.stake, {
        isAllIn: loserSeat.isAllIn,
        isLastDodep: loserSeat.isLastDodep
      });
    }
    scheduleSave();

    addBotLog({
      source: transport.source,
      chatId: chat.chatId,
      chatTitle: chat.title,
      userName: loserSeat.firstName,
      event: `Верю — Не верю: ${bidWasTrue ? 'Заявка подтвердилась!' : 'БЛЕФ ВСКРЫТ!'}`,
      detail: `Ставка ${game.currentQty}×${game.currentFace}, выпало ${actualCount}. Проиграл ${loserSeat.firstName}`
    });

    const revealLines = game.seats.map(
      (s) =>
        `• ${s.firstName}: ${s.dice.map((d) => `${DIE_FACES[d]}`).join(' ')}${
          s.userId === loserSeat.userId ? ' 💀' : ' 🏆'
        }`
    );

    const verdictHeader = bidWasTrue
      ? `✅ ЗАЯВКА БЫЛА ЧЕСТНОЙ! (${actualCount} шт. ${DIE_FACES[game.currentFace]} >= ${game.currentQty})`
      : `🚨 БЛЕФ ВСКРЫТ! (${actualCount} шт. ${DIE_FACES[game.currentFace]} < ${game.currentQty})`;

    const lines = [
      `🔍 ВСКРЫТИЕ СТОЛА «ВЕРЮ — НЕ ВЕРЮ»!`,
      verdictHeader,
      ``,
      ...revealLines,
      ``,
      `💀 Попался: ${loserSeat.firstName} (-${game.stake} 🪙)`,
      `🏆 Победители (${winners.map((w) => w.firstName).join(', ')}) получают по ${share} 🪙!`
    ];

    await transport.answerCallback(callbackId, bidWasTrue ? '✅ Там правда было столько!' : '🚨 Блеф пойман!');
    await transport.editMessage(
      chat.chatId,
      game.messageId || messageId,
      lines.join('\n'),
      buildPostGameKeyboard('liarsdice', game.stake, false)
    );

    for (const w of winners) {
      const ps = chat.players[w.userId];
      if (ps && share - game.stake > 0) await applyAutoDebtCollection(transport, chat, ps, share - game.stake);
    }
    if (loserPs && loserPs.balance === 0) await maybeSendZeroBalanceOffer(transport, chat, loserPs);
    return;
  }

  await transport.answerCallback(callbackId);
}

// =====================================
// PROTECTED MESSAGES, SWEEPER & RUNTIME ADAPTER
// =====================================

export function isPartyGamesProtectedMsg(msgId: string): boolean {
  for (const g of battleshipGames.values()) if (g.messageId === msgId) return true;
  for (const d of chickenDuels.values()) if (d.messageId === msgId) return true;
  for (const l of blindLots.values()) if (l.messageId === msgId) return true;
  for (const g of liarsGames.values()) if (g.messageId === msgId) return true;
  return false;
}

export async function sweepExpiredPartyGames(now = Date.now()): Promise<void> {
  const db = getDb();

  // 1. Expired Battleship waiting lobbies (4 min)
  for (const [id, g] of Array.from(battleshipGames.entries())) {
    if (g.status === 'waiting' && now - g.createdAt >= LOBBY_IDLE_TTL_MS) {
      battleshipGames.delete(id);
      g.status = 'finished';
      markRuntimeDirty();
      const chat = db.chats[g.chatId];
      const creator = chat?.players[g.creatorId];
      if (creator) creator.balance += g.stake;
      scheduleSave();
      const tr = getPartyTransport(g.transportSource, g.chatId, g.transport);
      if (g.messageId && tr) {
        await tr.editMessage(
          g.chatId,
          g.messageId,
          `⏱ Вызов на Морской бой закрыт по таймауту (4 мин). Ставка ${g.stake} 🪙 возвращена.`,
          [[{ text: '🏠 В меню', callbackData: 'menu' }]]
        );
      }
    }
  }

  // 2. Expired Chicken Duel waiting lobbies (4 min)
  for (const [id, d] of Array.from(chickenDuels.entries())) {
    if (d.status === 'waiting' && now - d.createdAt >= LOBBY_IDLE_TTL_MS) {
      chickenDuels.delete(id);
      d.status = 'finished';
      markRuntimeDirty();
      const chat = db.chats[d.chatId];
      const creator = chat?.players[d.creatorId];
      if (creator) creator.balance += d.stake;
      scheduleSave();
      const tr = getPartyTransport(d.transportSource, d.chatId, d.transport);
      if (d.messageId && tr) {
        await tr.editMessage(
          d.chatId,
          d.messageId,
          `⏱ Дуэль «Курица» закрыта по таймауту (4 мин). Ставка ${d.stake} 🪙 возвращена.`,
          [[{ text: '🏠 В меню', callbackData: 'menu' }]]
        );
      }
    }
  }

  // 3. Auto-settle Blind Auctions when timer expires
  for (const lot of Array.from(blindLots.values())) {
    if (lot.status === 'active' && now >= lot.endsAt) {
      const chat = db.chats[lot.chatId];
      if (!chat) {
        blindLots.delete(lot.id);
        continue;
      }
      await settleBlindAuction(chat, lot);
    }
  }

  // 4. Expired Liar's Dice waiting lobbies (4 min)
  for (const [id, g] of Array.from(liarsGames.entries())) {
    if (g.status === 'waiting' && now - g.createdAt >= LOBBY_IDLE_TTL_MS) {
      liarsGames.delete(id);
      g.status = 'finished';
      markRuntimeDirty();
      const chat = db.chats[g.chatId];
      for (const s of g.seats) {
        const ps = chat?.players[s.userId];
        if (ps) ps.balance += g.stake;
      }
      scheduleSave();
      const tr = getPartyTransport(g.transportSource, g.chatId, g.transport);
      if (g.messageId && tr) {
        await tr.editMessage(
          g.chatId,
          g.messageId,
          `⏱ Стол «Верю — Не верю» закрыт по таймауту (4 мин). Все ставки возвращены.`,
          [[{ text: '🏠 В меню', callbackData: 'menu' }]]
        );
      }
    }
  }
}

registerRuntimeAdapter('partyGames', {
  exportState: () => ({
    battleshipGames: Array.from(battleshipGames.values()).map(({ transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
    chickenDuels: Array.from(chickenDuels.values()).map(({ transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
    blindLots: Array.from(blindLots.values()).map(({ transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
    liarsGames: Array.from(liarsGames.values()).map(({ transport: _tr, ...rest }) => ({
      ...rest,
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    }))
  }),
  importState: (raw: any) => {
    battleshipGames.clear();
    chickenDuels.clear();
    blindLots.clear();
    liarsGames.clear();

    if (Array.isArray(raw?.battleshipGames)) {
      for (const g of raw.battleshipGames) {
        if (g?.id && g.status !== 'finished') {
          battleshipGames.set(g.id, { ...g, transport: null });
        }
      }
    }
    if (Array.isArray(raw?.chickenDuels)) {
      for (const d of raw.chickenDuels) {
        if (d?.id && d.status !== 'finished') {
          chickenDuels.set(d.id, { ...d, choices: d.choices || {}, transport: null });
        }
      }
    }
    if (Array.isArray(raw?.blindLots)) {
      for (const l of raw.blindLots) {
        if (l?.id && l.status === 'active') {
          blindLots.set(l.id, { ...l, bidders: Array.isArray(l.bidders) ? l.bidders : [], transport: null });
        }
      }
    }
    if (Array.isArray(raw?.liarsGames)) {
      for (const g of raw.liarsGames) {
        if (g?.id && g.status !== 'finished') {
          liarsGames.set(g.id, { ...g, seats: Array.isArray(g.seats) ? g.seats : [], transport: null });
        }
      }
    }
  }
});
