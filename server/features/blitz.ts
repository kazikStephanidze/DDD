import {
  BotTransport,
  InlineKeyboard,
  applyAutoDebtCollection,
  displayName,
  playerLabel,
  shortId
} from '../engineShared.js';
import {
  ChatState,
  PlayerState,
  addBotLog,
  getDb,
  scheduleSave
} from '../storage.js';
import { unlockAchievement } from './profileQuests.js';
import {
  markRuntimeDirty,
  registerRuntimeAdapter,
  resolveRuntimeTransport
} from '../runtimeRegistry.js';

interface BlitzQuestionTemplate {
  question: string;
  correct: string;
  decoys: string[];
  explain: string;
}

interface ActiveBlitzRound {
  id: string;
  chatId: string;
  question: string;
  options: string[];
  correctIndex: number;
  explain: string;
  reward: number;
  wrongUserIds: Set<string>;
  winnerId: string | null;
  messageId: string | null;
  transportSource?: 'telegram' | 'simulator';
  transport?: BotTransport | null;
  createdAt: number;
  expiresAt: number;
}

const BLITZ_TTL_MS = 3 * 60 * 1000; // 3 minutes before blitz expires
const BLITZ_REWARD_POOL = [150, 180, 200, 250];

const BLITZ_QUESTIONS: BlitzQuestionTemplate[] = [
  {
    question: 'Поставил 250 🪙 в Плинко и шарик упал в лузу x2.4. Сколько фантиков упало обратно?',
    correct: '600 🪙',
    decoys: ['500 🪙', '625 🪙', '550 🪙'],
    explain: '250 × 2.4 = 600 🪙.'
  },
  {
    question: 'Какой множитель в Текстовой рулетке Дяди Депа даёт точное попадание в Зеро (0)?',
    correct: 'x14',
    decoys: ['x10', 'x20', 'x36'],
    explain: 'Зеро (0) платит x14 к ставке!'
  },
  {
    question: 'На столе Блэкджека у тебя на руках [A♠️] + [9♦️] + [5♣️]. Сколько это очков?',
    correct: '15 очков',
    decoys: ['25 очков', '14 очков', '16 очков'],
    explain: 'Туз автоматически считается как 1, чтобы не было перебора: 1 + 9 + 5 = 15.'
  },
  {
    question: 'Сколько слотов в барабане Русской рулетки Дяди Депа?',
    correct: '6 слотов (1 патрон)',
    decoys: ['5 слотов (1 патрон)', '8 слотов (2 патрона)', '7 слотов (1 патрон)'],
    explain: 'Классический револьвер: 6 камор, 1 боевой патрон.'
  },
  {
    question: 'На сколько минут проигравший в Русскую рулетку становится Призраком чата?',
    correct: 'На 3 минуты',
    decoys: ['На 5 минут', 'На 10 минут', 'На 1 минуту'],
    explain: 'Призрак чата отдыхает от ставок ровно 3 минуты.'
  },
  {
    question: 'Сколько талисманов одной редкости нужно сжечь в Крафте 3→1, чтобы получить ранг выше?',
    correct: '3 штуки',
    decoys: ['5 штук', '4 штуки', '10 штук'],
    explain: 'Контракт 3→1 плавит ровно 3 талисмана одного цвета.'
  },
  {
    question: 'Какой вес в 🍯 Общем Котле даёт любой 🔴 Уникальный талисман (1/1)?',
    correct: '8 500 билетов',
    decoys: ['3 800 билетов', '5 000 билетов', '10 000 билетов'],
    explain: 'Каждый 🔴 Уник в котле весит 8 500 билетов.'
  },
  {
    question: 'Во сколько ровно каждый вечер разыгрывается лотерея чата «Общак дня»?',
    correct: 'В 20:55',
    decoys: ['В 20:00', 'В 21:00', 'В 12:00'],
    explain: 'Розыгрыш в 20:55, а в 21:00 выходит вечерняя сводка дня.'
  },
  {
    question: 'Какой главный джекпот даёт комбинация 777 в Одноруком Дяде (Слот 🎰)?',
    correct: 'x20',
    decoys: ['x14', 'x30', 'x50'],
    explain: 'Три семёрки в слоте платят x20 от ставки!'
  },
  {
    question: 'Сколько всего этажей в башне «Лесенка додепа»?',
    correct: '6 этажей',
    decoys: ['5 этажей', '7 этажей', '8 этажей'],
    explain: 'В башне 6 этажей с 3 дверями на каждом.'
  },
  {
    question: 'В банке Дуэли 1×1 лежит 900 🪙. По сколько ставил каждый игрок (если выплата x2)?',
    correct: 'По 450 🪙',
    decoys: ['По 300 🪙', 'По 400 🪙', 'По 500 🪙'],
    explain: '900 / 2 = 450 🪙 с каждого бойца.'
  },
  {
    question: 'Сколько всего Уникальных реликвий (🔴 1/1) существует на один чат?',
    correct: '7 реликвий',
    decoys: ['5 реликвий', '10 реликвий', '12 реликвий'],
    explain: 'В Пантеоне каждого чата строго 7 уникальных реликвий.'
  },
  {
    question: 'Какую награду в 🪙 можно забрать кнопкой при нулевом балансе (раз в 15 минут)?',
    correct: '+350 🪙',
    decoys: ['+250 🪙', '+500 🪙', '+300 🪙'],
    explain: 'Антитильт-поддержка при нуле — +350 фантиков каждые 15 минут.'
  },
  {
    question: 'Поставил 150 🪙 на Зеро (x14) и шарик встал на 0. Какая чистая прибыль (сверх ставки)?',
    correct: '+1 950 🪙',
    decoys: ['+2 100 🪙', '+1 800 🪙', '+2 250 🪙'],
    explain: 'Выплата 150 × 14 = 2 100 🪙, минус ставка 150 = +1 950 🪙 чистого плюса.'
  },
  {
    question: 'Какой максимальный икс можно поймать в Плинко на Высоком риске?',
    correct: 'x12',
    decoys: ['x4.5', 'x10', 'x25'],
    explain: 'Крайние лузы Высокого риска Плинко дают x12.'
  },
  {
    question: 'Сколько тараканов бежит в заезде «Тараканьи бега»?',
    correct: '4 бойца',
    decoys: ['3 бойца', '5 бойцов', '6 бойцов'],
    explain: 'Виталя, Тормоз, Крысюк и Олигарх — ровно 4 дорожки.'
  },
  {
    question: 'Сколько ударов в полной серии игры «Пенальти»?',
    correct: '5 ударов',
    decoys: ['3 удара', '4 удара', '6 ударов'],
    explain: 'В серии ровно 5 ударов по 3 зонам ворот.'
  },
  {
    question: 'Что происходит при ничьей по номиналу карты в игре «Больше / Меньше» (Hi-Lo)?',
    correct: '«Пронесло!» — ставка жива, серия не сгорает',
    decoys: ['Мгновенный проигрыш', 'Удвоение икса x2', 'Ставка возвращается, серия сбрасывается'],
    explain: 'В Hi-Lo ничья не сжигает банк и просто меняет карту.'
  },
  {
    question: 'Во сколько каждый день приходит «Напутствие дня» в чаты?',
    correct: 'В 12:00',
    decoys: ['В 10:00', 'В 12:01', 'В 21:00'],
    explain: 'В 12:00 выходит Напутствие дня, а в 12:01 — Доска почёта.'
  }
];

const activeBlitzes = new Map<string, ActiveBlitzRound>();
const lastQuestionIdxByChat = new Map<string, number>();

registerRuntimeAdapter('blitz', {
  exportState: () => ({
    activeBlitzes: Array.from(activeBlitzes.values()).map(({ transport: _tr, wrongUserIds, ...rest }) => ({
      ...rest,
      wrongUserIds: Array.from(wrongUserIds),
      transportSource: rest.transportSource || (_tr?.source ?? (rest.chatId.startsWith('sim-') ? 'simulator' : 'telegram'))
    })),
    lastQuestionIdxByChat: Array.from(lastQuestionIdxByChat.entries())
  }),
  importState: (raw: any) => {
    activeBlitzes.clear();
    lastQuestionIdxByChat.clear();
    if (Array.isArray(raw?.activeBlitzes)) {
      for (const b of raw.activeBlitzes) {
        if (!b?.id || b.winnerId) continue;
        activeBlitzes.set(b.id, {
          ...b,
          wrongUserIds: new Set<string>(Array.isArray(b.wrongUserIds) ? b.wrongUserIds : []),
          transport: null
        });
      }
    }
    if (Array.isArray(raw?.lastQuestionIdxByChat)) {
      for (const [k, v] of raw.lastQuestionIdxByChat) {
        if (typeof k === 'string' && typeof v === 'number') {
          lastQuestionIdxByChat.set(k, v);
        }
      }
    }
  }
});

export function isBlitzProtectedMsg(msgId: string): boolean {
  for (const b of activeBlitzes.values()) {
    if (!b.winnerId && Date.now() < b.expiresAt && b.messageId === msgId) return true;
  }
  return false;
}

export function hasActiveBlitzForChat(chatId: string): boolean {
  const now = Date.now();
  for (const b of activeBlitzes.values()) {
    if (b.chatId === chatId && !b.winnerId && now < b.expiresAt) return true;
  }
  return false;
}

export async function sweepExpiredBlitzes(now = Date.now()): Promise<void> {
  const db = getDb();
  for (const [id, blitz] of Array.from(activeBlitzes.entries())) {
    if (blitz.winnerId || now < blitz.expiresAt) continue;
    activeBlitzes.delete(id);
    markRuntimeDirty();
    const chat = db.chats[blitz.chatId];
    addBotLog({
      source: 'scheduler',
      chatId: blitz.chatId,
      chatTitle: chat?.title || blitz.chatId,
      event: 'Блиц истёк (никто не забрал)',
      detail: `Банк ${blitz.reward} 🪙 остался у Дяди Депа`
    });
    const tr = resolveRuntimeTransport(blitz.transportSource, blitz.chatId, blitz.transport);
    if (blitz.messageId && tr) {
      await tr.editMessage(
        blitz.chatId,
        blitz.messageId,
        [
          `⚡ БЛИЦ ОТ ДЯДИ ДЕПА — ВРЕМЯ ВЫШЛО`,
          `❓ ${blitz.question}`,
          ``,
          `Никто не успел забрать быстрые +${blitz.reward} 🪙 за 3 минуты.`,
          `✅ Правильный ответ был: ${blitz.options[blitz.correctIndex]}`
        ].join('\n'),
        [[{ text: '🎰 Открыть стол', callbackData: 'menu' }]]
      );
    }
  }
}

export async function sendChatBlitzBroadcast(
  transport: BotTransport,
  chatId: string
): Promise<boolean> {
  const chat = getDb().chats[chatId];
  if (!chat || Object.keys(chat.players).length === 0) return false;
  if (hasActiveBlitzForChat(chatId)) return false;

  const prevIdx = lastQuestionIdxByChat.get(chatId) ?? -1;
  let qIdx = Math.floor(Math.random() * BLITZ_QUESTIONS.length);
  if (BLITZ_QUESTIONS.length > 1 && qIdx === prevIdx) {
    qIdx = (qIdx + 1) % BLITZ_QUESTIONS.length;
  }
  lastQuestionIdxByChat.set(chatId, qIdx);
  const tpl = BLITZ_QUESTIONS[qIdx];

  const allOptions = [
    { text: tpl.correct, isCorrect: true },
    ...tpl.decoys.map((d) => ({ text: d, isCorrect: false }))
  ];
  for (let i = allOptions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allOptions[i], allOptions[j]] = [allOptions[j], allOptions[i]];
  }
  const correctIndex = allOptions.findIndex((o) => o.isCorrect);
  const reward = BLITZ_REWARD_POOL[Math.floor(Math.random() * BLITZ_REWARD_POOL.length)];
  const now = Date.now();
  const id = shortId();

  const blitz: ActiveBlitzRound = {
    id,
    chatId,
    question: tpl.question,
    options: allOptions.map((o) => o.text),
    correctIndex,
    explain: tpl.explain,
    reward,
    wrongUserIds: new Set<string>(),
    winnerId: null,
    messageId: null,
    transportSource: transport.source,
    transport,
    createdAt: now,
    expiresAt: now + BLITZ_TTL_MS
  };
  activeBlitzes.set(id, blitz);
  markRuntimeDirty();

  chat.lastBlitzAt = now;
  scheduleSave();

  const text = [
    `⚡ БЛИЦ ОТ ДЯДИ ДЕПА · БЫСТРЫЙ БАНК +${reward} 🪙!`,
    ``,
    `❓ ${blitz.question}`,
    ``,
    `Кто первый тыкнет верный вариант — забирает +${reward} фантиков! Ошибся — в этом блице выбыл.`
  ].join('\n');

  const kb: InlineKeyboard = [
    [
      { text: blitz.options[0], callbackData: `blz:ans:${id}:0` },
      { text: blitz.options[1], callbackData: `blz:ans:${id}:1` }
    ],
    [
      { text: blitz.options[2], callbackData: `blz:ans:${id}:2` },
      { text: blitz.options[3], callbackData: `blz:ans:${id}:3` }
    ]
  ];

  const sentId = await transport.sendMessage(chatId, text, kb);
  blitz.messageId = sentId;

  addBotLog({
    source: transport.source === 'simulator' ? 'simulator' : 'scheduler',
    chatId,
    chatTitle: chat.title,
    event: `Блиц чата (+${reward} 🪙)`,
    detail: tpl.question.slice(0, 80)
  });

  return true;
}

export async function handleBlitzCallback(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  callbackId: string,
  messageId: string,
  parts: string[]
): Promise<void> {
  const sub = parts[1];
  const blitzId = parts[2];
  const optIdx = parseInt(parts[3] || '-1', 10);

  if (sub !== 'ans') {
    await transport.answerCallback(callbackId);
    return;
  }

  const blitz = activeBlitzes.get(blitzId);
  if (!blitz || blitz.winnerId || Date.now() >= blitz.expiresAt) {
    await transport.answerCallback(callbackId, 'Блиц уже забрали или время вышло!', true);
    return;
  }

  if (blitz.wrongUserIds.has(player.userId)) {
    await transport.answerCallback(callbackId, '❌ Ты уже промахнулся в этом блице — жди следующий!', true);
    return;
  }

  if (optIdx !== blitz.correctIndex) {
    blitz.wrongUserIds.add(player.userId);
    markRuntimeDirty();
    await transport.answerCallback(callbackId, '❌ Мимо! Неверный ответ — в этом раунде ты выбыл.', true);
    return;
  }

  // First correct answer!
  blitz.winnerId = player.userId;
  activeBlitzes.delete(blitz.id);
  markRuntimeDirty();

  player.balance += blitz.reward;
  player.stats.totalWon += blitz.reward;
  if (player.balance >= 5000) unlockAchievement(chat, player, 'oligarch_5k');
  scheduleSave();

  const sec = Math.max(1, Math.round((Date.now() - blitz.createdAt) / 1000));
  await transport.answerCallback(callbackId, `⚡ В точку! +${blitz.reward} 🪙 на баланс!`);

  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: `Блиц выигран (+${blitz.reward} 🪙)`,
    detail: `Верный ответ за ${sec} сек`
  });

  const targetMsgId = blitz.messageId || messageId;
  const winText = [
    `⚡ БЛИЦ ЗАКРЫТ — ПОБЕДИТЕЛЬ НАЙДЕН!`,
    `❓ ${blitz.question}`,
    ``,
    `🏆 ${playerLabel(chat, player)} ответил первым за ${sec} сек и забрал +${blitz.reward} 🪙!`,
    `✅ Ответ: ${blitz.options[blitz.correctIndex]} — ${blitz.explain}`,
    `🪙 Баланс победителя: ${player.balance} фантиков`
  ].join('\n');

  if (targetMsgId) {
    await transport.editMessage(chat.chatId, targetMsgId, winText, [
      [{ text: '🎰 Открыть стол', callbackData: 'menu' }]
    ]);
  } else {
    await transport.sendMessage(chat.chatId, winText, [
      [{ text: '🎰 Открыть стол', callbackData: 'menu' }]
    ]);
  }

  await applyAutoDebtCollection(transport, chat, player, blitz.reward);
}
