import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { CatalogStats } from '../types';

interface PhrasesViewProps {
  stats: CatalogStats;
}

export function PhrasesView({ stats }: PhrasesViewProps) {
  const [sampleQuote, setSampleQuote] = useState<string>(
    'Волк не тот, кто никогда не сливал. Волк тот, кто после слива зарядил ласт додеп и ушёл с банком. Ауф 🐺'
  );
  const [sampleGuidance, setSampleGuidance] = useState<string>(
    '🔥 Напутствие на день: не путайте рабочий тильт с холодным расчётом. Кто сегодня первым поймает жирный икс — тот и главный авторитет до самого вечера.'
  );
  const [loading, setLoading] = useState(false);

  const generateSample = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/phrases/sample', { method: 'POST' });
      const data = await res.json();
      if (data.quote) setSampleQuote(data.quote);
      if (data.guidance) setSampleGuidance(data.guidance);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Уникальные пацанские фразы и напутствие дня</h1>
          <p className="text-sm text-slate-600 mt-1">
            Все реплики написаны вручную без склейки шаблонов — ровно по {stats.phrasesPerCategory} цельных фраз в пацанском ауф-стиле на каждую игровую и чатовую ситуацию.
          </p>
        </div>
        <button
          type="button"
          onClick={generateSample}
          disabled={loading}
          className="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Показать другие примеры</span>
        </button>
      </div>

      {/* Quantitative Summary Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Всего уникальных фраз</div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {stats.totalUniquePhrases.toLocaleString('ru-RU')}
          </div>
          <div className="text-xs text-slate-500 mt-1">цельные авторские реплики без повторов подряд</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Ситуаций и категорий</div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {stats.categoriesCount}
          </div>
          <div className="text-xs text-slate-500 mt-1">игры, бонусы, призрак, чат и 12:00</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Фраз на каждый вид</div>
          <div className="text-2xl font-bold font-mono-num text-emerald-700 mt-1">
            {stats.phrasesPerCategory}
          </div>
          <div className="text-xs text-slate-500 mt-1">не повторяются, пока не прокрутится весь пул</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Триггеров живого чата</div>
          <div className="text-2xl font-bold font-mono-num text-slate-900 mt-1">
            {stats.triggerKeywordsCount}
          </div>
          <div className="text-xs text-slate-500 mt-1">слов про бабки, казик, слив, деп и тильт</div>
        </div>
      </div>

      {/* Live Preview Samples */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-base font-bold text-slate-900 mb-3">
            Пример реакции в живом чате
          </h2>
          <p className="text-sm leading-relaxed text-slate-800 bg-slate-50 border border-slate-200 rounded-lg p-4">
            {sampleQuote}
          </p>
          <p className="text-xs text-slate-500 mt-3">
            Срабатывает со 100% вероятностью (не чаще 1 раза в 10 минут на чат) при упоминании денег, удачи, ставок, тильта, зарплаты, заноса, блэкджека или додепа.
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-base font-bold text-slate-900 mb-3">
            Пример напутствия дня в 12:00 (на весь чат)
          </h2>
          <p className="text-sm leading-relaxed text-slate-800 bg-slate-50 border border-slate-200 rounded-lg p-4">
            {sampleGuidance}
          </p>
          <p className="text-xs text-slate-500 mt-3">
            Отправляется автоматически ровно в 12:00 одним сообщением для всего чата без привязки к конкретному игроку и без кнопки в меню.
          </p>
        </div>
      </div>
    </div>
  );
}
