import React, { useEffect, useRef, useState } from 'react';
import { Globe, RefreshCw, Send, ShieldCheck, Trash2, UserCheck, Zap } from 'lucide-react';
import { FirebaseDbStatus, PlayerState, SimMessage, TelegramBotStatus } from '../types';
import { BotAvatar } from './BotAvatar';

interface SimulatorViewProps {
  messages: SimMessage[];
  players: PlayerState[];
  activeUserId: string;
  onSelectUser: (userId: string) => void;
  toast: { text: string; isAlert: boolean; id: string } | null;
  telegram: TelegramBotStatus;
  firebase?: FirebaseDbStatus;
  timezone: string;
  onSendCommand: (cmd: string) => Promise<void>;
  onSendText: (text: string, forceTrigger: boolean) => Promise<void>;
  onCallback: (messageId: string, callbackData: string) => Promise<void>;
  onSetZero: () => Promise<void>;
  onClearChat: () => Promise<void>;
  onUpdateConfig: (token: string, timezone: string) => Promise<void>;
  onRestartBot: () => Promise<void>;
  onStopBot: () => Promise<void>;
  onSetupWebhook: (webhookUrl?: string) => Promise<{ ok: boolean; error?: string; webhookUrl?: string }>;
}

const SAMPLE_TRIGGERS = [
  'Опять слил всю зарплату в казик',
  'Ребята, сегодня точно повезёт, делаем додеп!',
  'Поймал тильт, отмазки не будет',
  'Занос на x10 или кредит на фриспины?'
];

export function SimulatorView({
  messages,
  players,
  activeUserId,
  onSelectUser,
  toast,
  telegram,
  timezone,
  onSendCommand,
  onSendText,
  onCallback,
  onSetZero,
  onClearChat,
  onUpdateConfig,
  onRestartBot,
  onStopBot,
  onSetupWebhook,
  firebase
}: SimulatorViewProps) {
  const [input, setInput] = useState('');
  const [forceTrigger, setForceTrigger] = useState(true);
  const [tokenInput, setTokenInput] = useState('');
  const [tzInput, setTzInput] = useState(timezone);
  const [savingConfig, setSavingConfig] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [webhookNote, setWebhookNote] = useState<string | null>(null);

  const feedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setTzInput(timezone);
  }, [timezone]);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages.length, messages[messages.length - 1]?.text]);

  const activePlayer = players.find((p) => p.userId === activeUserId) || players[0];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput('');
    await onSendText(trimmed, forceTrigger);
  };

  const handleConfigSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingConfig(true);
    try {
      await onUpdateConfig(tokenInput, tzInput);
      setTokenInput('');
    } finally {
      setSavingConfig(false);
    }
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Main Focal Anchor: Interactive Telegram-style Simulator */}
      <section className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col h-[740px]">
        {/* Chat Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4 bg-white">
          <div className="flex items-center gap-3 min-w-0">
            <BotAvatar size="md" />
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-900 truncate">
                Дядя Деп
              </h2>
              <p className="text-xs text-slate-500 truncate">
                Чат-симулятор · Активен: {activePlayer ? `${activePlayer.firstName} (${activePlayer.balance} фантиков)` : 'Загрузка...'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onSendCommand('/menu')}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              /menu
            </button>
            <button
              type="button"
              onClick={() => onSendCommand('/me')}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              /me
            </button>
            <button
              type="button"
              onClick={onClearChat}
              title="Очистить историю симулятора"
              className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Toast / Callback Alert Banner */}
        {toast && (
          <div
            className={`px-4 py-2 text-xs font-medium border-b ${
              toast.isAlert
                ? 'bg-amber-50 text-amber-900 border-amber-200'
                : 'bg-emerald-50 text-emerald-900 border-emerald-200'
            }`}
          >
            {toast.isAlert ? 'Уведомление бота: ' : 'Ответ кнопки: '}
            {toast.text}
          </div>
        )}

        {/* Messages Feed */}
        <div
          ref={feedRef}
          className="flex-1 overflow-y-auto p-5 space-y-4 bg-slate-900"
        >
          {messages.map((msg) => {
            const isBot = msg.sender === 'bot';
            const isMinesGrid =
              msg.keyboard &&
              msg.keyboard.length >= 5 &&
              msg.keyboard[0]?.length === 5;

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isBot ? 'items-start' : 'items-end'}`}
              >
                <div
                  className={`max-w-[90%] md:max-w-[82%] rounded-xl px-4 py-3 ${
                    isBot
                      ? 'bg-slate-800 text-slate-100 border border-slate-700'
                      : 'bg-emerald-700 text-white'
                  }`}
                >
                  <div className="flex items-center justify-between gap-4 mb-1">
                    <span className="text-xs font-semibold text-emerald-300">
                      {msg.senderName}
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono-num">
                      {formatTime(msg.timestamp)}
                    </span>
                  </div>
                  <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {msg.text}
                  </div>
                </div>

                {/* Telegram-style Inline Keyboard directly below bot message */}
                {isBot && msg.keyboard && msg.keyboard.length > 0 && (
                  <div
                    className={`mt-1.5 flex flex-col gap-1.5 ${
                      isMinesGrid ? 'w-[280px]' : 'w-full max-w-[90%] md:max-w-[82%]'
                    }`}
                  >
                    {msg.keyboard.map((row, rIdx) => (
                      <div
                        key={rIdx}
                        className="grid gap-1.5"
                        style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
                      >
                        {row.map((btn, bIdx) => (
                          <button
                            key={`${rIdx}-${bIdx}-${btn.callbackData}`}
                            type="button"
                            onClick={() => onCallback(msg.id, btn.callbackData)}
                            className="min-h-[38px] px-2.5 py-2 text-xs font-medium text-slate-100 bg-slate-800/90 hover:bg-slate-700 active:scale-[0.98] border border-slate-700 rounded-lg transition-all text-center truncate cursor-pointer"
                            title={btn.text}
                          >
                            {btn.text}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Chat Input Bar */}
        <form
          onSubmit={handleSubmit}
          className="p-3.5 border-t border-slate-200 bg-white flex items-center gap-2.5"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Напиши фразу в чат (напр. «слил зарплату в казик») или /start..."
            className="flex-1 px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
          />
          <button
            type="submit"
            className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Send className="w-4 h-4" />
            <span>Отправить</span>
          </button>
        </form>
      </section>

      {/* Right Sidebar: Player Switcher, Quick Tests & Live Telegram Status */}
      <aside className="lg:col-span-4 space-y-5">
        {/* Active Player Switcher (for testing multiplayer Russian Roulette & balances) */}
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-bold text-slate-900">Игроки в симуляторе</h3>
            <span className="text-xs text-slate-500">Для теста 2–3 чел.</span>
          </div>

          <div className="divide-y divide-slate-100">
            {players.map((p) => {
              const isSelected = p.userId === activeUserId;
              const isGhost = p.ghostUntil > Date.now();
              const ghostMins = Math.ceil((p.ghostUntil - Date.now()) / 60000);

              return (
                <button
                  key={p.userId}
                  type="button"
                  onClick={() => onSelectUser(p.userId)}
                  className={`w-full py-2.5 px-3 text-left flex items-center justify-between gap-3 rounded-lg transition-colors cursor-pointer ${
                    isSelected ? 'bg-emerald-50 text-emerald-950' : 'hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-semibold truncate">
                      {isSelected && <UserCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
                      <span className="truncate">{p.firstName}</span>
                    </div>
                    <div className="text-xs text-slate-500">
                      {isGhost ? `Призрак чата · ${ghostMins} мин` : `Игр: ${p.stats.gamesPlayed}`}
                    </div>
                  </div>
                  <div className="text-sm font-bold font-mono-num text-slate-900 shrink-0">
                    {p.balance} 🪙
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onSetZero}
              className="flex-1 px-3 py-2 text-xs font-medium text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Обнулить баланс (тест бонуса)
            </button>
          </div>
        </div>

        {/* Live-chat trigger test phrases */}
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-bold text-slate-900">Тест реакций в живом чате</h3>
            <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={forceTrigger}
                onChange={(e) => setForceTrigger(e.target.checked)}
                className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-600"
              />
              <span>Без кулдауна</span>
            </label>
          </div>
          <p className="text-xs text-slate-500 mb-3">
            В реальном Telegram: шанс 100%, кулдаун 10 мин на чат. В симуляторе при галочке «Без кулдауна» отвечает сразу.
          </p>
          <div className="space-y-1.5">
            {SAMPLE_TRIGGERS.map((phrase) => (
              <button
                key={phrase}
                type="button"
                onClick={() => onSendText(phrase, forceTrigger)}
                className="w-full text-left px-3 py-2 text-xs text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
              >
                <Zap className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="truncate">{phrase}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Telegram Bot Connection & Configuration */}
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="text-sm font-bold text-slate-900">Подключение Telegram</h3>
            <span
              className={`text-xs font-semibold ${
                telegram.running ? 'text-emerald-700' : 'text-red-600'
              }`}
            >
              {telegram.running ? 'Онлайн' : 'Офлайн'}
            </span>
          </div>

          <div className="text-xs text-slate-600 space-y-1 mb-4">
            <div>
              Бот:{' '}
              {telegram.username ? (
                <span className="font-semibold text-slate-900 font-mono-num">
                  @{telegram.username} ({telegram.firstName})
                </span>
              ) : (
                <span className="text-slate-500">не подключён</span>
              )}
            </div>
            <div>
              Режим:{' '}
              <span className="font-mono-num font-medium text-slate-800">
                {telegram.mode === 'webhook' ? 'Webhook (Vercel)' : 'Polling (Локальный)'}
              </span>
            </div>
            {telegram.webhookUrl && (
              <div className="truncate" title={telegram.webhookUrl}>
                Webhook: <span className="font-mono-num text-emerald-700">{telegram.webhookUrl}</span>
              </div>
            )}
            {firebase && (
              <div>
                База данных:{' '}
                <span className={`font-medium ${firebase.lastError ? 'text-red-600' : 'text-emerald-700'}`}>
                  {firebase.lastError ? `RTDB ошибка: ${firebase.lastError}` : 'Firebase RTDB подключена'}
                </span>
              </div>
            )}
            <div>
              Часовой пояс рассылки: <span className="font-mono-num font-medium">{timezone}</span>
            </div>
            {telegram.lastError && (
              <div className="text-red-600 bg-red-50 border border-red-200 rounded-lg p-2 mt-2">
                {telegram.lastError}
              </div>
            )}
            {webhookNote && (
              <div className="text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2 mt-2">
                {webhookNote}
              </div>
            )}
          </div>

          {telegram.username && (
            <div
              className={`mb-4 p-3 rounded-lg text-xs flex items-start gap-2 border ${
                telegram.canReadAllGroupMessages === false
                  ? 'bg-amber-50 border-amber-200 text-amber-950'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-900'
              }`}
            >
              <ShieldCheck
                className={`w-4 h-4 shrink-0 mt-0.5 ${
                  telegram.canReadAllGroupMessages === false ? 'text-amber-700' : 'text-emerald-700'
                }`}
              />
              <div>
                {telegram.canReadAllGroupMessages === false ? (
                  <>
                    <strong>Group Privacy сейчас ВКЛЮЧЁН!</strong> Telegram скрывает от бота обычные сообщения в группе. В{' '}
                    <span className="font-mono-num">@BotFather</span> выбери <span className="font-mono-num">/setprivacy → Disable</span> (не Enable!) и передобавь бота в группу — либо сразу дай ему права <strong>Админа</strong> в группе.
                  </>
                ) : (
                  <>
                    Group Privacy отключён — бот читает триггер-слова в группе (шанс 100%, кулдаун 10 мин).
                  </>
                )}
              </div>
            </div>
          )}

          <form onSubmit={handleConfigSave} className="space-y-2.5">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Часовой пояс (12:00 / 12:01)
              </label>
              <input
                type="text"
                value={tzInput}
                onChange={(e) => setTzInput(e.target.value)}
                placeholder="Europe/Minsk"
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg font-mono-num focus:outline-none focus:border-emerald-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Новый токен бота (опционально)
              </label>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Оставьте пустым, чтобы сохранить текущий"
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg font-mono-num focus:outline-none focus:border-emerald-600"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={savingConfig}
                className="flex-1 px-3 py-2 text-xs font-medium bg-slate-900 hover:bg-slate-800 text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50"
              >
                {savingConfig ? 'Сохранение...' : 'Применить настройки'}
              </button>
              <button
                type="button"
                disabled={busyAction}
                onClick={async () => {
                  setBusyAction(true);
                  try {
                    await onRestartBot();
                  } finally {
                    setBusyAction(false);
                  }
                }}
                className="px-3 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                title="Перезапустить подключение Telegram"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Рестарт</span>
              </button>
              {telegram.mode !== 'webhook' && telegram.running && (
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={async () => {
                    setBusyAction(true);
                    setWebhookNote(null);
                    try {
                      await onStopBot();
                      setWebhookNote('Локальный polling остановлен — можно проверять Webhook на Vercel.');
                    } finally {
                      setBusyAction(false);
                    }
                  }}
                  className="w-full px-3 py-2 text-xs font-medium bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                  title="Остановить локального бота в AI Studio, чтобы не перехватывал Webhook у Vercel"
                >
                  Пауза Polling (для теста Vercel)
                </button>
              )}
              <button
                type="button"
                disabled={busyAction}
                onClick={async () => {
                  setBusyAction(true);
                  setWebhookNote(null);
                  try {
                    const res = await onSetupWebhook();
                    if (res.ok) {
                      setWebhookNote(`Webhook привязан: ${res.webhookUrl || 'готово'}`);
                    } else {
                      setWebhookNote(res.error || 'Не удалось установить Webhook');
                    }
                  } finally {
                    setBusyAction(false);
                  }
                }}
                className="w-full px-3 py-2 text-xs font-medium bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-200 rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                title="Привязать Telegram Webhook к текущему HTTPS-домену Vercel"
              >
                <Globe className="w-3.5 h-3.5" />
                <span>Установить Webhook (для Vercel)</span>
              </button>
            </div>
          </form>
        </div>
      </aside>
    </div>
  );
}
