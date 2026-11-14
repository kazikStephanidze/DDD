import { BotLogEntry, ChatSummary } from '../types';

interface EconomyViewProps {
  chats: ChatSummary[];
  logs: BotLogEntry[];
  onTriggerBroadcast: (includeTelegram: boolean, type?: 'both' | 'evening' | 'lottery' | 'blitz' | 'all') => Promise<void>;
}

export function EconomyView({ chats, logs, onTriggerBroadcast }: EconomyViewProps) {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Изолированная экономика чатов</h1>
          <p className="text-sm text-slate-600 mt-1">
            Балансы, талисманы, таймер бонуса (15 мин), автоудаление (5 мин), лотерея в 20:55 и сводка дня в 21:00.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onTriggerBroadcast(true, 'both')}
            className="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Напутствие и топ (12:00)
          </button>
          <button
            type="button"
            onClick={() => onTriggerBroadcast(true, 'lottery')}
            className="px-4 py-2 text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            🎟️ Лотерея (20:55)
          </button>
          <button
            type="button"
            onClick={() => onTriggerBroadcast(true, 'blitz')}
            className="px-4 py-2 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            ⚡ Блиц (10:00–20:00)
          </button>
          <button
            type="button"
            onClick={() => onTriggerBroadcast(true, 'evening')}
            className="px-4 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-900 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Сводка за сутки (21:00)
          </button>
        </div>
      </div>

      {/* Chats Tables */}
      <div className="space-y-6">
        {chats.map((chat) => {
          const players = [...chat.players].sort((a, b) => b.balance - a.balance);
          const posCounts = new Map<string, number>();
          const addPoint = (uid?: string) => {
            if (!uid) return;
            posCounts.set(uid, (posCounts.get(uid) || 0) + 1);
          };

          const richest = players[0];
          if (richest && richest.balance > 0) addPoint(richest.userId);
          const feeder = [...chat.players].sort((a, b) => b.stats.totalLost - a.stats.totalLost)[0];
          if (feeder && feeder.stats.totalLost > 0) addPoint(feeder.userId);
          const coldHead = [...chat.players].sort((a, b) => b.stats.maxCrashMultiplier - a.stats.maxCrashMultiplier)[0];
          if (coldHead && coldHead.stats.maxCrashMultiplier > 0) addPoint(coldHead.userId);
          const dodepKing = [...chat.players].sort((a, b) => b.stats.lastDodepWins - a.stats.lastDodepWins)[0];
          if (dodepKing && dodepKing.stats.lastDodepWins > 0) addPoint(dodepKing.userId);

          const debtMap = new Map<string, number>();
          for (const l of chat.loans || []) {
            if (l.status !== 'active') continue;
            const rem = Math.max(0, l.repayAmount - l.paidAmount);
            if (rem > 0) debtMap.set(l.borrowerId, (debtMap.get(l.borrowerId) || 0) + rem);
          }
          const topDebtorEntry = [...debtMap.entries()].sort((a, b) => b[1] - a[1])[0];
          if (topDebtorEntry) addPoint(topDebtorEntry[0]);

          const ghostKing = [...chat.players].sort((a, b) => (b.stats.ghostCount || 0) - (a.stats.ghostCount || 0))[0];
          if (ghostKing && (ghostKing.stats.ghostCount || 0) > 0) addPoint(ghostKing.userId);
          const allInKing = [...chat.players].sort((a, b) => (b.stats.allInCount || 0) - (a.stats.allInCount || 0))[0];
          if (allInKing && (allInKing.stats.allInCount || 0) > 0) addPoint(allInKing.userId);
          const bonusKing = [...chat.players].sort((a, b) => (b.stats.zeroBonusCount || 0) - (a.stats.zeroBonusCount || 0))[0];
          if (bonusKing && (bonusKing.stats.zeroBonusCount || 0) > 0) addPoint(bonusKing.userId);
          const collectorKing = [...chat.players].sort(
            (a, b) =>
              (b.collectionSummary?.score || 0) - (a.collectionSummary?.score || 0) ||
              (b.collectionSummary?.count || 0) - (a.collectionSummary?.count || 0)
          )[0];
          if (collectorKing && (collectorKing.collectionSummary?.count || 0) > 0) {
            addPoint(collectorKing.userId);
          }

          const topHolder = [...posCounts.entries()]
            .map(([uid, count]) => ({ player: chat.players.find((p) => p.userId === uid), count }))
            .filter((x) => Boolean(x.player))
            .sort((a, b) => b.count - a.count)[0];

          return (
            <section key={chat.chatId} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-bold text-slate-900">{chat.title}</h2>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono-num">
                    ID: {chat.chatId} · Тип: {chat.type} · Игроков: {players.length} · Билетов в лотерее: {chat.lotteryTicketsCount || 0} · Цитат: {chat.usedQuotesCount}
                  </p>
                </div>
                {players.length > 0 && (
                  <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span>Олигарх: <strong className="text-slate-900">{richest?.firstName}</strong></span>
                    <span aria-hidden="true">·</span>
                    <span>Кормилец: <strong className="text-slate-900">{feeder?.stats.totalLost > 0 ? feeder.firstName : '—'}</strong></span>
                    <span aria-hidden="true">·</span>
                    <span>Призрак: <strong className="text-slate-900">{(ghostKing?.stats.ghostCount || 0) > 0 ? `${ghostKing.firstName} (${ghostKing.stats.ghostCount})` : '—'}</strong></span>
                    <span aria-hidden="true">·</span>
                    <span>Коллекционер: <strong className="text-slate-900">{(collectorKing?.collectionSummary?.count || 0) > 0 ? `${collectorKing.firstName} (${collectorKing.collectionSummary?.count})` : '—'}</strong></span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Статистика статистики:{' '}
                      <strong className="font-mono-num text-emerald-700">
                        {topHolder?.player ? `${topHolder.player.firstName} (${topHolder.count}/9)` : '0/9'}
                      </strong>
                    </span>
                  </div>
                )}
              </div>

              {players.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  В этом чате ещё никто не нажал /start.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-2.5 px-6">Игрок</th>
                        <th className="py-2.5 px-4 text-right">Баланс</th>
                        <th className="py-2.5 px-4 text-right">Игр</th>
                        <th className="py-2.5 px-4 text-right">Слито всего</th>
                        <th className="py-2.5 px-4 text-right">Талисманы</th>
                        <th className="py-2.5 px-4 text-right">Макс. икс (Краш)</th>
                        <th className="py-2.5 px-4 text-right">Побед x2 додепом</th>
                        <th className="py-2.5 px-6 text-right">Статус</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {players.map((p) => {
                        const isGhost = p.ghostUntil > Date.now();
                        const ghostMins = Math.max(1, Math.ceil((p.ghostUntil - Date.now()) / 60000));
                        const talCount = p.collectionSummary?.count ?? p.talismans?.length ?? 0;
                        const talUniq = p.collectionSummary?.uniqueCount ?? 0;
                        return (
                          <tr key={p.userId} className="hover:bg-slate-50/70">
                            <td className="py-2.5 px-6 font-medium text-slate-900">
                              {p.firstName}
                              {p.username && (
                                <span className="ml-2 text-xs text-slate-400 font-normal">@{p.username}</span>
                              )}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono-num font-semibold text-slate-900">
                              {p.balance} 🪙
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono-num text-slate-600">
                              {p.stats.gamesPlayed}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono-num text-red-600">
                              {p.stats.totalLost}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono-num text-slate-700">
                              {talCount} шт.{talUniq > 0 ? ` (${talUniq} уник.)` : ''}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono-num text-emerald-700">
                              x{p.stats.maxCrashMultiplier.toFixed(2)}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono-num text-slate-700">
                              {p.stats.lastDodepWins}
                            </td>
                            <td className="py-2.5 px-6 text-right text-xs">
                              {isGhost ? (
                                <span className="text-amber-700 font-medium">Призрак ({ghostMins} мин)</span>
                              ) : p.balance === 0 ? (
                                <span className="text-red-600 font-medium">На нуле</span>
                              ) : (
                                <span className="text-emerald-700">В игре</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {chat.loans && chat.loans.length > 0 && (
                <div className="px-6 py-4 border-t border-slate-200 bg-amber-50/50">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-amber-900 mb-2">
                    Активные P2P долги в чате ({chat.loans.length})
                  </h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {chat.loans.map((loan) => {
                      const rem = Math.max(0, loan.repayAmount - loan.paidAmount);
                      const overdue = Date.now() >= loan.dueAt;
                      return (
                        <div
                          key={loan.id}
                          className="flex items-center justify-between gap-3 bg-white border border-amber-200 rounded-lg px-3 py-2 text-xs"
                        >
                          <div className="text-slate-800">
                            <span className="font-semibold">{loan.borrowerName}</span> →{' '}
                            <span className="font-semibold">{loan.lenderName}</span>
                            <span className="text-slate-500 ml-1.5">(+{loan.interestPct}%)</span>
                          </div>
                          <div className="font-mono-num text-right shrink-0">
                            <span className="font-bold text-slate-900">{rem} 🪙</span>
                            {overdue ? (
                              <span className="ml-2 text-red-600 font-semibold">ПРОСРОЧЕН</span>
                            ) : (
                              <span className="ml-2 text-emerald-700">в срок</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* Live Events Log */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-base font-bold text-slate-900">Журнал событий бота</h2>
        </div>
        {logs.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">Событий пока нет.</div>
        ) : (
          <div className="overflow-x-auto max-h-[380px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-2.5 px-6">Время</th>
                  <th className="py-2.5 px-4">Источник</th>
                  <th className="py-2.5 px-4">Чат / Игрок</th>
                  <th className="py-2.5 px-4">Событие</th>
                  <th className="py-2.5 px-6">Детали</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50">
                    <td className="py-2 px-6 font-mono-num text-slate-500 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleTimeString('ru-RU')}
                    </td>
                    <td className="py-2 px-4 text-slate-700 font-medium">{log.source}</td>
                    <td className="py-2 px-4 text-slate-800">
                      {log.chatTitle}
                      {log.userName ? ` · ${log.userName}` : ''}
                    </td>
                    <td className="py-2 px-4 font-semibold text-slate-900">{log.event}</td>
                    <td className="py-2 px-6 text-slate-600">{log.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
