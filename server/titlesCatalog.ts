export type TitleCategory = 'self' | 'prank';

export interface TitleDef {
  id: string;
  category: TitleCategory;
  emoji: string;
  name: string;
  price: number;
  desc: string;
}

export const PRANK_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
export const CLEANSE_PRANK_PRICE = 30_000;

export const TITLES_CATALOG: TitleDef[] = [
  // ==========================================
  // ЛИЧНЫЕ ТИТУЛЫ (ПОКУПАЮТСЯ НАВСЕГДА)
  // ==========================================
  {
    id: 't1',
    category: 'self',
    emoji: '🎰',
    name: 'Сын маминой рулетки',
    price: 5_000,
    desc: 'Для тех, кто только почувствовал запах крупных заносов'
  },
  {
    id: 't2',
    category: 'self',
    emoji: '🍜',
    name: 'Повелитель дошираков',
    price: 7_500,
    desc: 'Живёт красиво, но заначка всегда на чёрный день'
  },
  {
    id: 't3',
    category: 'self',
    emoji: '🧃',
    name: 'Ровный кент Дяди Депа',
    price: 10_000,
    desc: 'Свой пацан за любым столом чата'
  },
  {
    id: 't4',
    category: 'self',
    emoji: '🍾',
    name: 'Прокурор пельменной',
    price: 15_000,
    desc: 'Судит ставки строго, но с душой'
  },
  {
    id: 't5',
    category: 'self',
    emoji: '🦊',
    name: 'Хитрый заносчик',
    price: 20_000,
    desc: 'Заходит тихо — выходит с двойным банком'
  },
  {
    id: 't6',
    category: 'self',
    emoji: '💼',
    name: 'Министр додепа',
    price: 30_000,
    desc: 'Подписывает указы на удвоение ставки'
  },
  {
    id: 't7',
    category: 'self',
    emoji: '🦈',
    name: 'Акула общака',
    price: 45_000,
    desc: 'Плавает там, где у новичков кончается баланс'
  },
  {
    id: 't8',
    category: 'self',
    emoji: '🧨',
    name: 'Отморозок ва-банка',
    price: 60_000,
    desc: 'Мелкие кнопки ему жмут карман'
  },
  {
    id: 't9',
    category: 'self',
    emoji: '🎩',
    name: 'Барон красного сектора',
    price: 80_000,
    desc: 'Крутит рулетку в цилиндре и не моргает'
  },
  {
    id: 't10',
    category: 'self',
    emoji: '👑',
    name: 'Шейх с маршрутки',
    price: 100_000,
    desc: 'Понтов на миллион даже в час пик'
  },
  {
    id: 't11',
    category: 'self',
    emoji: '💎',
    name: 'Крипто-батюшка',
    price: 150_000,
    desc: 'Отпускает грехи за проигранный ласт додеп'
  },
  {
    id: 't12',
    category: 'self',
    emoji: '🦅',
    name: 'Император на минималках',
    price: 200_000,
    desc: 'Правит столом, пока не ушёл в сапёра на 7 минах'
  },
  {
    id: 't13',
    category: 'self',
    emoji: '🏛️',
    name: 'Крыша Дяди Депа',
    price: 300_000,
    desc: 'Даже коллектор здоровается за руку'
  },
  {
    id: 't14',
    category: 'self',
    emoji: '🔥',
    name: 'Бессмертный олигарх',
    price: 450_000,
    desc: 'Фантиков столько, что хватает топить печку'
  },
  {
    id: 't15',
    category: 'self',
    emoji: '🚀',
    name: 'Хозяин Джет Икса',
    price: 600_000,
    desc: 'Ракета ждёт его разрешения на взлёт'
  },
  {
    id: 't16',
    category: 'self',
    emoji: '🚽',
    name: 'Золотой толчок чата',
    price: 800_000,
    desc: 'Высший символ бессмысленного богатства'
  },
  {
    id: 't17',
    category: 'self',
    emoji: '🪐',
    name: 'Бог рандома и шаурмы',
    price: 1_000_000,
    desc: 'Миллион фантиков? Просто сдача с обеда'
  },
  {
    id: 't18',
    category: 'self',
    emoji: '🪬',
    name: 'Властелин Вселенной Депа',
    price: 1_500_000,
    desc: 'Абсолютный предел пафоса в этом чате'
  },

  // ==========================================
  // ПРАНК-ПРОЗВИЩА НА СОСЕДА (НА 24 ЧАСА)
  // ==========================================
  {
    id: 'p1',
    category: 'prank',
    emoji: '🧦',
    name: 'Мокрый носок Дяди Депа',
    price: 15_000,
    desc: 'Повесить другу позорный ярлык на 24 часа'
  },
  {
    id: 'p2',
    category: 'prank',
    emoji: '🤡',
    name: 'Кормилец казино №1',
    price: 25_000,
    desc: 'Пусть весь чат знает главного спонсора кассы'
  },
  {
    id: 'p3',
    category: 'prank',
    emoji: '🐌',
    name: 'Тормоз тараканьих бегов',
    price: 35_000,
    desc: 'Человек-коэффициент x12 по скорости мыслей'
  },
  {
    id: 'p4',
    category: 'prank',
    emoji: '🧻',
    name: 'Инвестор в бублик',
    price: 50_000,
    desc: 'Закупает воздух по выгодному курсу'
  },
  {
    id: 'p5',
    category: 'prank',
    emoji: '🪣',
    name: 'Дырявый карман',
    price: 75_000,
    desc: 'Сливает банк быстрее, чем грузится телега'
  },
  {
    id: 'p6',
    category: 'prank',
    emoji: '🥬',
    name: 'Корм для таракана Витали',
    price: 100_000,
    desc: 'Любимое угощение фаворита бегов'
  },
  {
    id: 'p7',
    category: 'prank',
    emoji: '💩',
    name: 'Жертва ласт-додепа',
    price: 150_000,
    desc: 'Классика: нажал x2 и ушёл гулять'
  },
  {
    id: 'p8',
    category: 'prank',
    emoji: '🫃',
    name: 'Взял кредит на дошик',
    price: 250_000,
    desc: 'Самый элитный и обидный пранк на богача'
  }
];

export const SELF_TITLES: TitleDef[] = TITLES_CATALOG.filter((t) => t.category === 'self');
export const PRANK_TITLES: TitleDef[] = TITLES_CATALOG.filter((t) => t.category === 'prank');
export const TITLE_BY_ID: Record<string, TitleDef> = Object.fromEntries(
  TITLES_CATALOG.map((t) => [t.id, t])
);

export function formatTitlePrice(price: number): string {
  return price.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function getActiveTitleTag(player: {
  equippedTitleId?: string | null;
  ownedTitles?: string[];
  prankTitle?: { titleId: string; fromName: string; expiresAt: number } | null;
}): { label: string; isPrank: boolean; expiresAt?: number; fromName?: string } | null {
  const now = Date.now();
  if (player.prankTitle && player.prankTitle.expiresAt > now) {
    const prankDef = TITLE_BY_ID[player.prankTitle.titleId];
    if (prankDef) {
      return {
        label: `${prankDef.emoji} ${prankDef.name}`,
        isPrank: true,
        expiresAt: player.prankTitle.expiresAt,
        fromName: player.prankTitle.fromName
      };
    }
  }
  if (player.equippedTitleId && (player.ownedTitles || []).includes(player.equippedTitleId)) {
    const def = TITLE_BY_ID[player.equippedTitleId];
    if (def) {
      return {
        label: `${def.emoji} ${def.name}`,
        isPrank: false
      };
    }
  }
  return null;
}
