import {
  BotTransport,
  displayName,
  getActiveLoansForBorrower,
  getRemainingDebt,
  isLoanOverdue
} from '../engineShared';
import { ChatState, PlayerState, addBotLog, scheduleSave } from '../storage';
import {
  TALISMAN_BY_ID,
  TALISMAN_INCOME_MIN_CLAIM,
  TALISMAN_INCOME_PER_HOUR,
  TALISMAN_PASSIVE_CAP_HOURS,
  TALISMAN_PASSIVE_TOP_SLOTS
} from '../talismans';
import { unlockAchievement } from './profileQuests';

export interface TalismanIncomeSnapshot {
  hourlyRate: number;
  activeCount: number;
  totalCount: number;
  accruedExact: number;
  pendingCoins: number;
  capCoins: number;
  isFull: boolean;
}

export interface ClaimIncomeResult {
  ok: boolean;
  reason?: string;
  collected: number;
  debtCollected: number;
  netReceived: number;
  collectedLines: string[];
  snapshot: TalismanIncomeSnapshot;
}

export function formatHourlyRate(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(1);
}

export function calcTalismanIncomeRate(player: PlayerState): {
  hourlyRate: number;
  activeCount: number;
  totalCount: number;
} {
  const list = player.talismans || [];
  if (list.length === 0) {
    return { hourlyRate: 0, activeCount: 0, totalCount: 0 };
  }

  const rates: number[] = [];
  for (const item of list) {
    const def = TALISMAN_BY_ID[item.talismanId];
    if (!def) continue;
    rates.push(TALISMAN_INCOME_PER_HOUR[def.rarity] || 0);
  }

  rates.sort((a, b) => b - a);
  const topSlice = rates.slice(0, TALISMAN_PASSIVE_TOP_SLOTS);
  const hourlyRate = topSlice.reduce((sum, r) => sum + r, 0);

  return {
    hourlyRate,
    activeCount: topSlice.length,
    totalCount: rates.length
  };
}

export function getTalismanIncomeSnapshot(player: PlayerState, now = Date.now()): TalismanIncomeSnapshot {
  const { hourlyRate, activeCount, totalCount } = calcTalismanIncomeRate(player);
  const capCoins = Math.round(hourlyRate * TALISMAN_PASSIVE_CAP_HOURS);
  const baseAccrued = Math.max(0, player.talismanIncomeAccrued || 0);
  const lastAt = player.lastTalismanIncomeAt || now;
  const elapsedHours = hourlyRate > 0 ? Math.max(0, (now - lastAt) / 3_600_000) : 0;

  let accruedExact = baseAccrued;
  if (hourlyRate > 0) {
    if (baseAccrued >= capCoins) {
      // Preserve any already accumulated coins if vault exceeded new smaller cap
      accruedExact = baseAccrued;
    } else {
      accruedExact = Math.min(capCoins, baseAccrued + elapsedHours * hourlyRate);
    }
  }

  const pendingCoins = Math.floor(accruedExact);
  const isFull = capCoins > 0 && pendingCoins >= capCoins;

  return {
    hourlyRate,
    activeCount,
    totalCount,
    accruedExact,
    pendingCoins,
    capCoins,
    isFull
  };
}

export function syncTalismanPassiveIncome(player: PlayerState, now = Date.now()): TalismanIncomeSnapshot {
  const snap = getTalismanIncomeSnapshot(player, now);
  player.talismanIncomeAccrued = snap.accruedExact;
  player.lastTalismanIncomeAt = now;
  return snap;
}

export function claimTalismanPassiveIncome(
  transport: BotTransport,
  chat: ChatState,
  player: PlayerState,
  now = Date.now()
): ClaimIncomeResult {
  const snap = syncTalismanPassiveIncome(player, now);
  const available = Math.floor(player.talismanIncomeAccrued || 0);

  if (available < TALISMAN_INCOME_MIN_CLAIM) {
    return {
      ok: false,
      reason:
        snap.hourlyRate > 0
          ? `В копилке пока ${available} 🪙 (минимум ${TALISMAN_INCOME_MIN_CLAIM} 🪙 для сбора, капает +${formatHourlyRate(snap.hourlyRate)} 🪙/ч).`
          : `Копилка пуста! Выбей талисманы из кейсов, чтобы пошёл пассивный доход.`,
      collected: 0,
      debtCollected: 0,
      netReceived: 0,
      collectedLines: [],
      snapshot: snap
    };
  }

  player.talismanIncomeAccrued = Math.max(0, (player.talismanIncomeAccrued || 0) - available);

  // Check overdue P2P debts: collector takes up to 50% of passive rent
  const activeLoans = getActiveLoansForBorrower(chat, player.userId);
  const overdueLoans = activeLoans
    .filter((l) => isLoanOverdue(l, now))
    .sort((a, b) => a.createdAt - b.createdAt);

  let debtCollected = 0;
  const collectedLines: string[] = [];

  if (overdueLoans.length > 0) {
    let budget = Math.floor(available * 0.5);
    for (const loan of overdueLoans) {
      if (budget <= 0) break;
      const rem = getRemainingDebt(loan);
      if (rem <= 0) continue;

      const take = Math.min(rem, budget);
      if (take <= 0) continue;

      budget -= take;
      debtCollected += take;
      loan.paidAmount += take;

      const lender = chat.players[loan.lenderId];
      if (lender) lender.balance += take;

      const leftAfter = getRemainingDebt(loan);
      if (leftAfter === 0) loan.status = 'repaid';

      const statusStr = leftAfter === 0 ? 'долг полностью закрыт ✅' : `осталось ${leftAfter} 🪙`;
      collectedLines.push(`• ${loan.lenderName}: +${take} 🪙 (${statusStr})`);
    }
  }

  const netReceived = available - debtCollected;
  if (netReceived > 0) {
    player.balance += netReceived;
    player.stats.totalWon += netReceived;
    if (player.balance >= 5000) {
      unlockAchievement(chat, player, 'oligarch_5k');
    }
  }

  scheduleSave();

  addBotLog({
    source: transport.source,
    chatId: chat.chatId,
    chatTitle: chat.title,
    userName: displayName(player),
    event: `Рента талисманов: +${available} 🪙`,
    detail:
      debtCollected > 0
        ? `На руки +${netReceived} 🪙, коллектор списал 50% (${debtCollected} 🪙) в просроченный долг`
        : `Чистыми на баланс +${netReceived} 🪙 (${formatHourlyRate(snap.hourlyRate)}/ч)`
  });

  return {
    ok: true,
    collected: available,
    debtCollected,
    netReceived,
    collectedLines,
    snapshot: getTalismanIncomeSnapshot(player, now)
  };
}
