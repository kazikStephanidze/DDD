import { useCallback, useEffect, useState } from 'react';
import { ConceptView } from './components/ConceptView';
import { EconomyView } from './components/EconomyView';
import { PhrasesView } from './components/PhrasesView';
import { SimulatorView } from './components/SimulatorView';
import { PlayerState, SimMessage, SystemStatusResponse } from './types';

type TabKey = 'simulator' | 'economy' | 'phrases' | 'concept';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('simulator');
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const [messages, setMessages] = useState<SimMessage[]>([]);
  const [simPlayers, setSimPlayers] = useState<PlayerState[]>([]);
  const [activeUserId, setActiveUserId] = useState<string>('sim-user-1');
  const [toast, setToast] = useState<{ text: string; isAlert: boolean; id: string } | null>(null);
  const [broadcastBusy, setBroadcastBusy] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data: SystemStatusResponse = await res.json();
      setStatus(data);
    } catch {
      // ignore transient network errors
    }
  }, []);

  const fetchSimMessages = useCallback(async () => {
    try {
      const res = await fetch('/api/sim/messages?chatId=sim-chat-1');
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.messages || []);
      if (data.players) setSimPlayers(data.players);
      if (data.toast) setToast(data.toast);
    } catch {
      // ignore
    }
  }, []);

  const hasLiveGameInFeed = messages.slice(-6).some((m) =>
    /ПОСАДКА НА БОРТ|В ПОЛЁТЕ!|ТЁМНЫЙ АУКЦИОН|РАУНД \d\/6|ОЖИДАНИЕ СОПЕРНИКА|МОРСКОЙ БОЙ|ВЕРЮ — НЕ ВЕРЮ|ГОРЯЧАЯ КАРТОШКА|ДИНАМИТ ЗАЖЖЁН|ЗАБЕГ/i.test(
      m.text
    )
  );

  useEffect(() => {
    let statusTimer: ReturnType<typeof setInterval> | null = null;
    let simTimer: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (statusTimer) clearInterval(statusTimer);
      if (simTimer) clearInterval(simTimer);
      if (document.hidden) return;

      statusTimer = setInterval(fetchStatus, 10000);
      if (activeTab === 'simulator') {
        simTimer = setInterval(fetchSimMessages, hasLiveGameInFeed ? 1100 : 4000);
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        if (statusTimer) clearInterval(statusTimer);
        if (simTimer) clearInterval(simTimer);
        statusTimer = null;
        simTimer = null;
      } else {
        fetchStatus();
        if (activeTab === 'simulator') fetchSimMessages();
        startPolling();
      }
    };

    if (!document.hidden) {
      fetchStatus();
      if (activeTab === 'simulator') fetchSimMessages();
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (statusTimer) clearInterval(statusTimer);
      if (simTimer) clearInterval(simTimer);
    };
  }, [activeTab, fetchStatus, fetchSimMessages, hasLiveGameInFeed]);

  const handleSendCommand = async (command: string) => {
    const res = await fetch('/api/sim/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: 'sim-chat-1', userId: activeUserId, command })
    });
    const data = await res.json();
    setMessages(data.messages || []);
    if (data.players) setSimPlayers(data.players);
    if (data.toast) setToast(data.toast);
    fetchStatus();
  };

  const handleSendText = async (text: string, forceTrigger: boolean) => {
    const res = await fetch('/api/sim/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: 'sim-chat-1',
        userId: activeUserId,
        text,
        bypassCooldown: true,
        forceTrigger
      })
    });
    const data = await res.json();
    setMessages(data.messages || []);
    if (data.players) setSimPlayers(data.players);
    if (data.toast) setToast(data.toast);
    fetchStatus();
  };

  const handleCallback = async (messageId: string, callbackData: string) => {
    const res = await fetch('/api/sim/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: 'sim-chat-1',
        userId: activeUserId,
        messageId,
        callbackData
      })
    });
    const data = await res.json();
    setMessages(data.messages || []);
    if (data.players) setSimPlayers(data.players);
    if (data.toast) setToast(data.toast);
    fetchStatus();
  };

  const handleSetZero = async () => {
    await fetch('/api/sim/set-zero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: 'sim-chat-1', userId: activeUserId })
    });
    await fetchSimMessages();
    await fetchStatus();
  };

  const handleClearChat = async () => {
    const res = await fetch('/api/sim/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: 'sim-chat-1', userId: activeUserId })
    });
    const data = await res.json();
    setMessages(data.messages || []);
    setToast(null);
  };

  const handleUpdateConfig = async (token: string, timezone: string) => {
    const res = await fetch('/api/bot/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, timezone })
    });
    const data = await res.json().catch(() => ({ ok: false }));
    await fetchStatus();
    return data as { ok: boolean; error?: string };
  };

  const handleRestartBot = async () => {
    await fetch('/api/bot/restart', { method: 'POST' });
    await fetchStatus();
  };

  const handleStopBot = async () => {
    await fetch('/api/bot/stop', { method: 'POST' });
    await fetchStatus();
  };

  const handleSetupWebhook = async (webhookUrl?: string, token?: string) => {
    const payload: Record<string, string> = {};
    if (webhookUrl) payload.webhookUrl = webhookUrl;
    if (token) payload.token = token;
    const res = await fetch('/api/bot/webhook/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    await fetchStatus();
    return data as { ok: boolean; error?: string; webhookUrl?: string };
  };

  const handleBroadcastTest = async (
    includeTelegram = false,
    type: 'both' | 'evening' | 'lottery' | 'blitz' | 'all' = 'both'
  ) => {
    setBroadcastBusy(true);
    try {
      const res = await fetch('/api/broadcast/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, includeTelegram })
      });
      const data = await res.json();
      if (data.messages) setMessages(data.messages);
      setActiveTab('simulator');
      await fetchStatus();
    } finally {
      setBroadcastBusy(false);
    }
  };

  const tg = status?.telegram || {
    running: false,
    hasToken: false,
    username: null,
    firstName: null,
    botId: null,
    canReadAllGroupMessages: null,
    startedAt: null,
    lastError: null
  };

  const navItems: { key: TabKey; label: string }[] = [
    { key: 'simulator', label: 'Симулятор' },
    { key: 'economy', label: 'Экономика чатов' },
    { key: 'phrases', label: 'Фразы и напутствие' },
    { key: 'concept', label: 'Концепция' }
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('simulator')}
            className="text-xl font-bold tracking-tight text-slate-900 font-display whitespace-nowrap shrink-0 cursor-pointer"
          >
            Дядя Деп
          </button>

          {/* Zone 2: 4 single-line text navigation links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
            {navItems.map((item) => {
              const active = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer border-b-2 ${
                    active
                      ? 'text-slate-900 border-emerald-600 font-semibold'
                      : 'text-slate-500 border-transparent hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: 1 Primary Action */}
          <div className="shrink-0">
            <button
              type="button"
              disabled={broadcastBusy}
              onClick={() => handleBroadcastTest(false)}
              className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {broadcastBusy ? 'Отправка...' : 'Тест рассылки 12:00'}
            </button>
          </div>
        </div>

        {/* Mobile Nav Row */}
        <div className="md:hidden border-t border-slate-100 px-4 py-2 flex items-center gap-4 overflow-x-auto">
          {navItems.map((item) => {
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`text-xs font-medium whitespace-nowrap shrink-0 py-1 cursor-pointer ${
                  active ? 'text-emerald-700 font-semibold' : 'text-slate-500'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Quiet unboxed metadata summary strip */}
      <div className="max-w-[1280px] w-full mx-auto px-6 pt-5 pb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>
          Telegram:{' '}
          <strong className="font-medium text-slate-800">
            {tg.running && tg.username ? `@${tg.username}` : tg.running ? 'Подключён' : 'Не подключён'}
          </strong>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Чатов в базе:{' '}
          <strong className="font-mono-num font-medium text-slate-800">
            {status?.chats.length ?? 0}
          </strong>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Время бота ({status?.timezone || 'Europe/Minsk'}):{' '}
          <strong className="font-mono-num font-medium text-slate-800">
            {status
              ? `${String(status.zonedNow.hour).padStart(2, '0')}:${String(status.zonedNow.minute).padStart(2, '0')}`
              : '--:--'}
          </strong>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Уникальных фраз:{' '}
          <strong className="font-mono-num font-medium text-slate-800">
            {status ? status.catalogStats.totalUniquePhrases.toLocaleString('ru-RU') : '2 160'}
          </strong>
        </span>
        {status?.firebase && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              БД:{' '}
              <strong
                className={`font-medium ${
                  status.firebase.lastError ? 'text-red-600' : 'text-emerald-700'
                }`}
              >
                {status.firebase.lastError ? 'RTDB ошибка' : 'Firebase RTDB'}
              </strong>
            </span>
          </>
        )}
      </div>

      {/* Main Content */}
      <main className="max-w-[1280px] w-full mx-auto px-6 py-5 flex-1">
        {activeTab === 'simulator' && (
          <SimulatorView
            messages={messages}
            players={simPlayers}
            activeUserId={activeUserId}
            onSelectUser={setActiveUserId}
            toast={toast}
            telegram={tg}
            firebase={status?.firebase}
            timezone={status?.timezone || 'Europe/Minsk'}
            onSendCommand={handleSendCommand}
            onSendText={handleSendText}
            onCallback={handleCallback}
            onSetZero={handleSetZero}
            onClearChat={handleClearChat}
            onUpdateConfig={handleUpdateConfig}
            onRestartBot={handleRestartBot}
            onStopBot={handleStopBot}
            onSetupWebhook={handleSetupWebhook}
          />
        )}

        {activeTab === 'economy' && (
          <EconomyView
            chats={status?.chats || []}
            logs={status?.logs || []}
            onTriggerBroadcast={(includeTg, type) => handleBroadcastTest(includeTg, type)}
          />
        )}

        {activeTab === 'phrases' && status && <PhrasesView stats={status.catalogStats} />}

        {activeTab === 'concept' && (
          <ConceptView telegram={tg} timezone={status?.timezone || 'Europe/Minsk'} />
        )}
      </main>
    </div>
  );
}
