import { TalismanRarity } from './storage';

export interface TalismanDef {
  id: string;
  emoji: string;
  name: string;
  rarity: TalismanRarity;
  recycleValue: number; // 0 for unique (cannot be recycled)
  lore: string;
}

export interface CaseDef {
  id: 'bomzh' | 'diplomat' | 'obschak' | 'safe';
  emoji: string;
  name: string;
  shortName: string;
  price: number;
  description: string;
  weights: Record<TalismanRarity, number>; // sum = 1000 (0.1% precision)
}

export const RARITY_META: Record<
  TalismanRarity,
  { label: string; shortLabel: string; badge: string; order: number }
> = {
  common: { label: 'Дефолтный', shortLabel: 'Дефолт', badge: '⚪', order: 1 },
  rare: { label: 'Редкий', shortLabel: 'Редкий', badge: '🟢', order: 2 },
  epic: { label: 'Эпический', shortLabel: 'Эпик', badge: '🟣', order: 3 },
  legendary: { label: 'Легендарный', shortLabel: 'Лега', badge: '🟡', order: 4 },
  unique: { label: 'Уникальный (1/1)', shortLabel: 'Уник', badge: '🔴', order: 5 }
};

export const TALISMAN_CATALOG: TalismanDef[] = [
  // ⚪ Common (Дефолтный) — 130–190 🪙
  { id: 'coin_five', emoji: '🪙', name: 'Мятый пятак', rarity: 'common', recycleValue: 130, lore: 'Протёртый до дыр, но пару раз спасал на ласт-спине.' },
  { id: 'pawn_receipt', emoji: '🧻', name: 'Чек из ломбарда', rarity: 'common', recycleValue: 140, lore: 'Напоминание о том, как начинался прошлый камбэк.' },
  { id: 'chifir', emoji: '☕', name: 'Крепкий чифир', rarity: 'common', recycleValue: 150, lore: 'Бодрит лучше кофе, когда сидишь в Краше до x5.' },
  { id: 'lucky_sock', emoji: '🧦', name: 'Фартовый носок', rarity: 'common', recycleValue: 155, lore: 'Не стиран с прошлого заноса, чтобы не спугнуть удачу.' },
  { id: 'cig_butt', emoji: '🚬', name: 'Сига на нервах', rarity: 'common', recycleValue: 160, lore: 'Классический атрибут ожидания последнего шарика в Плинко.' },
  { id: 'crooked_die', emoji: '🎲', name: 'Кривой кубик', rarity: 'common', recycleValue: 170, lore: 'Чуть стёртая пятёрка, зато душа лежит на шестёрке.' },
  { id: 'sour_lemon', emoji: '🍋', name: 'Кислый лимон', rarity: 'common', recycleValue: 180, lore: 'Выпал в слоте 777, но пацаны из него лимонад делают.' },
  { id: 'old_ticket', emoji: '🎟️', name: 'Старый билетик', rarity: 'common', recycleValue: 190, lore: 'Счастливый номер на маршрутку домой после катки.' },

  // 🟢 Rare (Редкий) — 380–520 🪙
  { id: 'four_leaf', emoji: '🍀', name: 'Четырёхлистник', rarity: 'rare', recycleValue: 380, lore: 'Сорван у входа в подпольный клуб ровно в полночь.' },
  { id: 'x_magnet', emoji: '🧲', name: 'Магнит иксов', rarity: 'rare', recycleValue: 410, lore: 'Тянет зелёные коэффициенты в Минах и Краше.' },
  { id: 'shot_glass', emoji: '🥃', name: 'Стопка храбрости', rarity: 'rare', recycleValue: 430, lore: 'После неё кнопка «Ва-банк» нажимается без дрожи.' },
  { id: 'evil_eye', emoji: '🧿', name: 'Глаз от тильта', rarity: 'rare', recycleValue: 450, lore: 'Отражает сглаз всего чата, когда ставишь на Зеро.' },
  { id: 'sapper_shovel', emoji: '💣', name: 'Лопатка сапёра', rarity: 'rare', recycleValue: 470, lore: 'Помогает обходить мины на сетке 5×5 с каменным лицом.' },
  { id: 'trump_six', emoji: '🃏', name: 'Козырная шестёрка', rarity: 'rare', recycleValue: 490, lore: 'Скромная карта, которая бьёт даже туза в нужный час.' },
  { id: 'lucky_gloves', emoji: '🧤', name: 'Перчатки крупье', rarity: 'rare', recycleValue: 500, lore: 'Сшиты для чистой раздачи на 21 очко.' },
  { id: 'battle_rooster', emoji: '🐓', name: 'Боевой петух', rarity: 'rare', recycleValue: 520, lore: 'Главный консультант на тараканьих бегах.' },

  // 🟣 Epic (Эпический) — 1000–1400 🪙
  { id: 'wolf_fang', emoji: '🐺', name: 'Волчий оскал', rarity: 'epic', recycleValue: 1000, lore: 'Символ тех, кто не сдаётся после трёх сливов подряд. Ауф!' },
  { id: 'jackpot_shard', emoji: '💎', name: 'Осколок джекпота', rarity: 'epic', recycleValue: 1080, lore: 'Откалывается только у тех, кто ловил крайние лузы Плинко.' },
  { id: 'rocket_fuel', emoji: '🚀', name: 'Топливо ракеты', rarity: 'epic', recycleValue: 1150, lore: 'Заливается в Краш, чтобы лететь выше x10 без паники.' },
  { id: 'poker_shades', emoji: '🕶️', name: 'Очки покериста', rarity: 'epic', recycleValue: 1200, lore: 'Через них дилер никогда не увидит твоей нервной улыбки.' },
  { id: 'dodep_bolt', emoji: '⚡', name: 'Молния додепа', rarity: 'epic', recycleValue: 1260, lore: 'Заряжает кнопку x2 на уверенный ночной отыгрыш.' },
  { id: 'croupier_orb', emoji: '🔮', name: 'Шар крупье', rarity: 'epic', recycleValue: 1320, lore: 'Нашептывает, куда упадёт следующая карта в Hi-Lo.' },
  { id: 'obschak_snake', emoji: '🐍', name: 'Змея общака', rarity: 'epic', recycleValue: 1360, lore: 'Охраняет проценты по выданным в чате займам.' },
  { id: 'eternal_flame', emoji: '🔥', name: 'Вечный огонёк', rarity: 'epic', recycleValue: 1400, lore: 'Пылает в груди, даже когда на балансе остался полтинник.' },

  // 🟡 Legendary (Легендарный) — 2600–3800 🪙
  { id: 'dodep_cup', emoji: '🏆', name: 'Кубок ласт-додепа', rarity: 'legendary', recycleValue: 2600, lore: 'Трофей настоящих легенд камбэка с последнего патрона.' },
  { id: 'croc_case', emoji: '🐊', name: 'Кожаный кейс', rarity: 'legendary', recycleValue: 2800, lore: 'В таких носили бабки самые дерзкие авторитеты стола.' },
  { id: 'luck_trident', emoji: '🔱', name: 'Вилы удачи', rarity: 'legendary', recycleValue: 3000, lore: 'Разворачивают любую чёрную полосу в золотой поток.' },
  { id: 'gold_eagle', emoji: '🦅', name: 'Золотой беркут', rarity: 'legendary', recycleValue: 3200, lore: 'Видит победную дорожку таракана ещё до старта заезда.' },
  { id: 'oligarch_bag', emoji: '💰', name: 'Мешок олигарха', rarity: 'legendary', recycleValue: 3400, lore: 'Тяжёлый груз фантиков, который греет душу в топе.' },
  { id: 'white_shark', emoji: '🦈', name: 'Белая акула', rarity: 'legendary', recycleValue: 3600, lore: 'Хищник стола, который забирает чужие банки без лишних слов.' },
  { id: 'luck_hourglass', emoji: '⏳', name: 'Часы фарта', rarity: 'legendary', recycleValue: 3800, lore: 'Останавливают время ровно за секунду до взрыва ракеты.' },

  // 🔴 Unique (Уникальный — 1 из 1 на чат, переработка НЕЛЬЗЯ)
  { id: 'dep_crown', emoji: '👑', name: 'Корона Дяди Депа', rarity: 'unique', recycleValue: 0, lore: 'Главная реликвия чата. Носит только один человек на весь стол.' },
  { id: 'unicorn_x1000', emoji: '🦄', name: 'Единорог x1000', rarity: 'unique', recycleValue: 0, lore: 'Мифический зверь, которого видели лишь избранные лудики.' },
  { id: 'stone_face', emoji: '🗿', name: 'Каменное лицо', rarity: 'unique', recycleValue: 0, lore: 'Высшая форма хладнокровия: ни один мускул не дрогнул на ва-банке.' },
  { id: 'casino_dragon', emoji: '🐉', name: 'Дракон казика', rarity: 'unique', recycleValue: 0, lore: 'Древний хранитель главного общака и счастливых семерок.' },
  { id: 'ufo_x', emoji: '🛸', name: 'Тарелка с иксами', rarity: 'unique', recycleValue: 0, lore: 'Прилетает раз в эпоху и увозит владельца в стратосферу почёта.' },
  { id: 'vault_key', emoji: '🗝️', name: 'Золотой ключ сейфа', rarity: 'unique', recycleValue: 0, lore: 'Единственный ключ от личного хранилища Дяди Депа.' },
  { id: 'phoenix_soul', emoji: '🐦‍🔥', name: 'Перо феникса', rarity: 'unique', recycleValue: 0, lore: 'Символ вечного возрождения из любого нуля на счету.' }
];

export const TALISMAN_BY_ID: Record<string, TalismanDef> = Object.fromEntries(
  TALISMAN_CATALOG.map((t) => [t.id, t])
);

export const UNIQUE_TALISMANS: TalismanDef[] = TALISMAN_CATALOG.filter(
  (t) => t.rarity === 'unique'
);

export const CASE_CATALOG: CaseDef[] = [
  {
    id: 'bomzh',
    emoji: '📦',
    name: 'Кейс «Бомж-пакет»',
    shortName: 'Бомж-пакет',
    price: 300,
    description: 'Народный кейс на сдачу. Чаще падают дефолты, но можно зацепить Редкий или Эпик.',
    weights: { common: 700, rare: 260, epic: 38, legendary: 2, unique: 0 }
  },
  {
    id: 'diplomat',
    emoji: '💼',
    name: 'Кейс «Пацанский дипломат»',
    shortName: 'Дипломат',
    price: 650,
    description: 'Доступный рабочий чемодан: в основном Редкие и Эпики + первый шанс на Уник!',
    weights: { common: 350, rare: 480, epic: 150, legendary: 19, unique: 1 }
  },
  {
    id: 'obschak',
    emoji: '🔥',
    name: 'Кейс «Блатной общак»',
    shortName: 'Общак',
    price: 1500,
    description: 'Без дефолтного хлама! Минимум Редкий, солидный шанс на Эпик/Легу и 1% на Уник.',
    weights: { common: 0, rare: 450, epic: 430, legendary: 110, unique: 10 }
  },
  {
    id: 'safe',
    emoji: '👑',
    name: 'Кейс «Сейф Дяди Депа»',
    shortName: 'Сейф Депа',
    price: 3500,
    description: 'Элитный сундук для охотников за Легендарками (50%) и Уникальными реликвиями (5%)!',
    weights: { common: 0, rare: 0, epic: 450, legendary: 500, unique: 50 }
  }
];

export const CASE_BY_ID: Record<string, CaseDef> = Object.fromEntries(
  CASE_CATALOG.map((c) => [c.id, c])
);

export function rollRarityForCase(caseDef: CaseDef): TalismanRarity {
  const roll = Math.random() * 1000;
  let acc = 0;
  const order: TalismanRarity[] = ['common', 'rare', 'epic', 'legendary', 'unique'];
  for (const r of order) {
    acc += caseDef.weights[r];
    if (roll < acc) return r;
  }
  return 'common';
}

export function getTalismansByRarity(rarity: TalismanRarity): TalismanDef[] {
  return TALISMAN_CATALOG.filter((t) => t.rarity === rarity);
}

export const UNIQUE_POT_WEIGHT = 8500;

export function getTalismanPotWeight(def: TalismanDef): number {
  return def.rarity === 'unique' ? UNIQUE_POT_WEIGHT : Math.max(10, def.recycleValue);
}

export function formatCaseOddsLine(caseDef: CaseDef): string {
  const parts: string[] = [];
  const order: TalismanRarity[] = ['common', 'rare', 'epic', 'legendary', 'unique'];
  for (const r of order) {
    const w = caseDef.weights[r];
    if (w <= 0) continue;
    const pct = w % 10 === 0 ? `${w / 10}%` : `${(w / 10).toFixed(1)}%`;
    parts.push(`${RARITY_META[r].badge} ${pct}`);
  }
  return parts.join(' · ');
}

export const TALISMAN_INCOME_PER_HOUR: Record<TalismanRarity, number> = {
  common: 3,
  rare: 8,
  epic: 20,
  legendary: 50,
  unique: 120
};

export const TALISMAN_PASSIVE_TOP_SLOTS = 8;
export const TALISMAN_PASSIVE_CAP_HOURS = 12;
export const TALISMAN_INCOME_MIN_CLAIM = 5;

