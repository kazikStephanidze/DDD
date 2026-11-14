# CONTEXT.md — Технический контекст проекта «Дядя Деп»

> Служебный файл-память для быстрого входа в проект при ремиксах и доработках. Содержит реальную архитектуру, контракты, экономические формулы, схемы callback-данных, инварианты и подводные камни.

---

## 1. Суть проекта и стек

**«Дядя Деп»** — гибридное приложение:
1. **Production Telegram-бот** на `grammy` (long polling) в стиле «пацанской лудо-философии».
2. **Веб-панель и интерактивный чат-симулятор** (React 19 + Tailwind CSS v4), работающие поверх **единого** игрового движка `server/botEngine.ts` через абстракцию `BotTransport`.

**Стек и запуск:**
- Runtime / Backend: Node.js + `tsx` + Express (`server.ts`, порт **3000**).
- Frontend: Vite + React 19 + TypeScript + Tailwind CSS v4 (`@tailwindcss/vite`) + `lucide-react`.
- Telegram SDK: `grammy` (`^1.46.0`).
- Хранилище: локальная JSON-БД `/data/dep-bot-db.json` (в `.gitignore`, атомарная запись через `.tmp` + `renameSync` с debounce 300 мс).
- Скрипты `package.json`:
  - `npm run dev` → `tsx server.ts` (поднимает Express + Vite middleware + Telegram-бота + планировщик).
  - `npm run start` → `tsx server.ts`.
  - `npm run build` → `vite build`.
  - `npm run lint` → `tsc --noEmit`.
- Переменные окружения (`.env.example`):
  - `TELEGRAM_BOT_TOKEN` — токен от `@BotFather` (можно также задать/обновить из UI через `/api/bot/config`).
  - `BOT_TIMEZONE` — IANA-таймзона (по умолчанию `Europe/Minsk`).
  - `GEMINI_API_KEY` — задекларирована в `.env.example`, в логике бота сейчас **не используется** (все фразы преднаписаны вручную).

---

## 2. Карта файлов

| Файл | Назначение |
|---|---|
| `server.ts` | Точка входа Express (порт 3000), `simulatorTransport`, REST API `/api/*`, сидинг `sim-chat-1`, запуск Telegram-бота и планировщика, Vite dev middleware / static `dist`. |
| `server/botEngine.ts` | **Ядро всей логики (~6163 строки):** роутинг команд и callback'ов, все 12 игр, Котёл талисманов, P2P-займы + Коллектор, кейсы/шкатулка, расчёты доски почёта (9 номинаций) и вечерней сводки, автореакции в чате. |
| `server/telegramBot.ts` | Инициализация `grammy.Bot`, `createTelegramTransport`, привязка `/start`, `/menu`, `/top`, `callback_query:data`, `message`, планировщик `12:00 / 12:01 / 21:00` (интервал 20 сек) и автоудаление старых сообщений бота (интервал 8 сек). |
| `server/storage.ts` | Типы БД, константы балансов/таймеров, загрузка/сохранение `/data/dep-bot-db.json`, миграции старых записей, сид `sim-chat-1` с 3 тестовыми игроками, лог событий в памяти (`logs`, до 150 записей), учёт `trackedBotMessages` и `getZonedDateTimeParts`. |
| `server/talismans.ts` | Каталог 38 талисманов 5 редкостей (`common`, `rare`, `epic`, `legendary`, `unique`), 4 кейса (`bomzh`, `diplomat`, `obschak`, `safe`), веса выпадения (сумма 1000 = точность 0.1%), веса билетов для Котла (`UNIQUE_POT_WEIGHT = 8500`). |
| `server/phrases.ts` | `CHAT_TRIGGER_KEYWORDS` (87 подстрок) и `PHRASE_POOLS`: **54 категории × 40 цельных фраз = 2160 уникальных фраз** + `pickNonRepeatingPhrase` (история на уровне чата). |
| `src/App.tsx` | Оболочка UI, polling `/api/status` (3.5 сек) и `/api/sim/messages` (650 мс), 4 вкладки, 3-зонная шапка. |
| `src/types.ts` | Клиентские TS-типы для API ответов, сообщений симулятора, логов и статистики. |
| `src/components/SimulatorView.tsx` | Левая колонка: Telegram-подобный чат с inline-клавиатурами и 5×5 сеткой Мин; правая: переключение 3 тестовых игроков (`sim-user-1..3`), обнуление баланса, тесты триггеров, настройки токена/таймзоны и предупреждение про Group Privacy. |
| `src/components/EconomyView.tsx` | Таблицы игроков по всем чатам (изолированная экономика), мини-лидерборд (в т.ч. `x/9` доминации), активные P2P-займы и live-журнал событий, кнопки ручной рассылки. |
| `src/components/PhrasesView.tsx` | Сводка по базе фраз (2160 / 54 / 40 / 87) и кнопка генерации случайного примера через `/api/phrases/sample`. |
| `src/components/ConceptView.tsx` | Документация концепции всех 12 игр, Котла, займов и расписания прямо в интерфейсе. |
| `src/components/BotAvatar.tsx` | Аватар бота (`/src/assets/images/dyadya_dep_avatar_1794553393202.jpg` с fallback-иконкой `Dices`). |

---

## 3. Архитектура транспортов и состояния

### `BotTransport` (единый интерфейс для TG и симулятора)
- `source`: `'telegram' | 'simulator'`
- `sendMessage(chatId, text, keyboard?)` → возвращает `messageId | null`
- `editMessage(chatId, messageId, text, keyboard?)`
- `sendDice(chatId, emoji?: '🎲' | '🎰')` → возвращает `{ value, messageId }` (`1..6` для `🎲`, `1..64` для `🎰`)
- `deleteMessage?(chatId, messageId)`
- `answerCallback(callbackId, text?, showAlert?)`
- `getRollDelayMs()` → `2200` мс в Telegram, `550` мс в симуляторе.

### Персистентность vs In-Memory сессии
- **В JSON-файле (`data/dep-bot-db.json`):** чаты (`chats[chatId]`), игроки (`chat.players[userId]`), их балансы, талисманы (`talismans`, `equippedTalismanId`), реестр уникальных реликвий чата (`chat.uniqueTalismans`), P2P-займы (`chat.loans`, `chat.loanRequests`), `dailyBaseline`, история фраз `usedPhraseKeys`, таймзона и `trackedBotMessages`.
- **Только в RAM (`server/botEngine.ts`):** активные игровые сессии (`crashSessions`, `russianLobbies`, `minesSessions`, `diceSessions`, `blackjackSessions`, `raceLobbies`, `hiloSessions`, `duelLobbies`, `ladderSessions`, `potLobbies`) и `playerActiveMenuMsgId`. При рестарте сервера незавершённые лобби/сессии сбрасываются.
- **Симулятор в RAM (`server.ts`):** `simMessagesByChat` (до 60 сообщений на чат, сообщения бота фильтруются по `BOT_MESSAGE_TTL_MS = 5 мин`), `lastSimToast`.

---

## 4. Команды и схема `callbackData`

Команды: `/start`, `/menu` (удаляет прошлое `playerActiveMenuMsgId` для `chatId:userId`, если оно не защищено `isProtectedInteractiveMessage`, и отправляет новое главное меню), `/top` (Доска позора и почёта).

| Префикс | Назначение | Основные поддействия / формат |
|---|---|---|
| `menu` | Главное меню (edit-in-place, если сообщение не защищено) | `menu` |
| `top` | Доска позора и почёта | `top` |
| `bonus` / `bonus_take` / `bonus_decline` | Бонус при нуле (+350 🪙) | проверка → взятие / отказ |
| `g:<game>` | Выбор игры → экран выбора ставки | `50`, `100`, `250`, `500`, `all` |
| `b:<game>:<amt>` / `rep:<game>:<amt>` / `ld:<game>:<amt>` | Ставка / Повтор / Ласт додеп (x2) | `<amt>` = число или `all`; `ld` ставит `isLastDodep=true` (удваивает, либо идёт ва-банк, если не хватает на x2) |
| `rl:<choice>:<stake>:<ld>` | Рулетка | `choice`: `red` \| `blk` \| `zer` |
| `cr:cash:<sid>` | Краш | кэшаут текущей сессии |
| `rr:...` | Русская рулетка | `rr:join:<id>`, `rr:go:<id>`, `rr:stop:<id>`, `rr:shot:<id>` |
| `mn:...` | Мины / Сапёр 5×5 | `mn:cfg:<3\|5\|7>:<stake>:<ld>`, `mn:c:<sid>:<idx>`, `mn:cash:<sid>`, `mn:noop` |
| `dc:roll:<sid>` | Кости | ответный бросок игрока |
| `bj:...` | Блэкджек (21) | `bj:hit:<sid>`, `bj:stand:<sid>`, `bj:dbl:<sid>` |
| `pl:go:<risk>:<stake>:<ld>` | Плинко | `risk`: `low` \| `med` \| `high` |
| `rc:...` | Тараканьи бега | `rc:new:<lane>:<stake>:<ld>`, `rc:join:<id>:<lane>`, `rc:go:<id>`, `rc:solo:<id>`, `rc:stop:<id>` |
| `hl:...` | Больше / Меньше (Hi-Lo) | `hl:hi:<sid>`, `hl:lo:<sid>`, `hl:cash:<sid>` |
| `dl:...` | Дуэль 1×1 (Орёл/Решка PvP) | `dl:new:<heads\|tails>:<stake>:<ld>`, `dl:join:<id>`, `dl:cancel:<id>` |
| `ldr:...` | Лесенка додепа (6 этажей) | `ldr:cfg:<easy\|hard>:<stake>:<ld>`, `ldr:pick:<sid>:<col>`, `ldr:cash:<sid>` |
| `tl:...` | Кейсы и шкатулка талисманов | `tl:menu`, `tl:shop`, `tl:buy:<caseId>`, `tl:bag:<page>`, `tl:view:<id>`, `tl:eq:<id>`, `tl:uneq`, `tl:rec:<id>`, `tl:recconf:<id>`, `tl:recdup`, `tl:pantheon` |
| `pot:...` | Общий Котёл талисманов | `pot:menu`, `pot:new`, `pot:refresh:<id>`, `pot:bag:<id>:<page>`, `pot:toss:<id>:<instId>`, `pot:addrand:<id>`, `pot:spin:<id>`, `pot:cancel:<id>` |
| `ln:...` | P2P Долги и займы | `ln:menu`, `ln:ask`, `ln:req:...`, `ln:lend:...`, `ln:cancel:...`, `ln:repay:...`, `ln:remind:...`, `ln:forgive:...` |

> **Важно:** Telegram ограничивает `callback_data` до **64 байт**. Сейчас все ID короткие (`shortId()` — 6 символов), поэтому лимит соблюдается. При добавлении новых callback'ов длину нужно контролировать.

---

## 5. Игры и математика выплат (12 игр + Общий Котёл)

1. **🎡 Рулетка (`roulette`):** `0..36`. Красное/Чёрное = **x2**, Зеро = **x14**. 2 промежуточных edit-кадра.
2. **🚀 Краш (`crash`):** 5% мгновенный краш `1.00`, иначе `min(35, max(1.08, 0.94 / (1 - u)))`. Тик каждые 1450 мс (TG) / 950 мс (Sim): `nextMult = currentMult + 0.11 + currentMult * 0.13`. Рекорд пишется в `stats.maxCrashMultiplier`.
3. **🔫 Русская рулетка (`russian`):** мультиплеер-лобби **2–3 игрока**, барабан 6 слотов, 1 патрон. Проигравший получает `ghostUntil = now + 3 мин` (ставки заблокированы, `stats.ghostCount++`), выжившие делят банк поровну.
4. **💣 Мины (`mines`):** сетка 5×5, `3 | 5 | 7` бомб. Комбинаторный множитель `0.97 / prob` (RTP 97%).
5. **🎲 Кости (`dice`):** нативный `sendDice('🎲')`. Бот кидает первым, игрок жмёт «Бросить в ответ!». Победа **x2**, ничья — возврат. Эмодзи автоудаляется через 8 сек.
6. **🃏 Блэкджек (`blackjack`):** колода 52 карты, дилер тянет до 17. Обычная победа **x2**, натуральные 21 с раздачи **x2.5**, ничья — возврат, есть Double Down (`bj:dbl`) на первых 2 картах.
7. **🔺 Плинко (`plinko`):** 6 рядов штырьков → 7 луз (биномиальное распределение, ~97.8% RTP). Риски: `low` (`x0.4..x2.4`), `med` (`x0.25..x4.5`), `high` (`x0.1..x12`). Пошаговая текстовая визуализация пирамиды.
8. **🪳 Тараканьи бега (`races`):** 4 дорожки (Виталя, Тормоз, Крысюк, Олигарх). Можно стартовать в соло (**x3.8**) или общим лобби чата (победившие делят банк).
9. **🎰 Слот 777 (`slots`):** нативный `sendDice('🎰')`, декодирование 6-битного `value - 1` на 3 барабана (`['🍫BAR', '🍇', '🍋', '7️⃣']`): `777` = **x20**, другие 3 в ряд = **x7.5**, две `7️⃣` = **x1.5**, пара подряд = **x0.5**. Эмодзи автоудаляется через 8 сек.
10. **↕️ Больше / Меньше (`hilo`):** 52 карты, честный расчёт иксов по оставшейся колоде (~96% RTP). Ничья по номиналу сохраняет ставку и обновляет карту.
11. **🪙 Дуэль 1×1 (`duel`):** PvP-монетка (Орёл/Решка) между двумя участниками чата, победитель забирает **x2**.
12. **🪜 Лесенка додепа (`ladder`):** 6 этажей × 3 двери. `easy` (2 сейфа, до **x10.94**), `hard` (1 сейф, до **x699.84**), ~96% RTP.
13. **🍯 Общий Котёл талисманов (`pot`):** CS-рулетка для шкатулки. Вес талисмана = `recycleValue`, для `unique` = **8 500 билетов**. Как только в котле ≥ 2 разных игрока — стартует 35-секундный автотаймер (или можно крутить вручную). Победитель забирает все талисманы, включая отжатие уников с обновлением `chat.uniqueTalismans`.

---

## 6. Экономика, талисманы, долги и статистика

- **Изоляция:** вся экономика, балансы, займы, уники и история фраз строго изолированы по `chatId`.
- **Старт:** `STARTING_BALANCE = 1000` 🪙.
- **Бонус при нуле:** `ZERO_BONUS_AMOUNT = 350` 🪙, только при `balance <= 0`, кулдаун `ZERO_BONUS_COOLDOWN_MS = 15 мин`. Долги **не** блокируют бонус.
- **Призрак чата:** `GHOST_DURATION_MS = 3 мин` после проигрыша в Русской рулетке. Блокирует вход во все игры.
- **Талисманы и кейсы (`server/talismans.ts`):**
  - 4 кейса: `bomzh` (300 🪙), `diplomat` (650 🪙), `obschak` (1500 🪙), `safe` (3500 🪙).
  - 5 редкостей: `common` (130–190 🪙), `rare` (380–520 🪙), `epic` (1000–1400 🪙), `legendary` (2600–3800 🪙), `unique` (7 штук на чат, `recycleValue = 0`, нельзя переработать; если выпадает уже занятый уник, система выдаёт другой свободный уник или компенсирует легендаркой + фантиками — детали в `openCaseForPlayer`).
  - Экипированный талисман (`equippedTalismanId`) отображается эмодзи перед именем игрока в `playerLabel(...)`.
- **P2P-займы («Пацанский общак») и Коллектор:**
  - Доступно игрокам с `gamesPlayed >= 3` (`MIN_GAMES_FOR_LOANS`).
  - Лимиты на заёмщика: макс `2` активных займа (`MAX_ACTIVE_LOANS_PER_BORROWER`), макс суммарный долг `1500` 🪙 (`MAX_TOTAL_DEBT_PER_BORROWER`).
  - Суммы: `100 / 250 / 500 / 1000` под `0% / +20% / +50%`. Срок: `LOAN_DURATION_MS = 2 часа`, затем метка `💸[ДОЛЖНИК]` в `playerLabel`.
  - Кулдаун напоминания: `LOAN_REMIND_COOLDOWN_MS = 10 мин`.
  - **Автоколлектор (`applyAutoDebtCollection`):** с каждого чистого выигрыша (`netProfit > 0`) автоматически переводит кредитору **50%** прибыли (или до **100%** при просрочке).
- **Доска позора и почёта (9 номинаций + «Статистика статистики»):**
  1. Олигарх чата (`balance`)
  2. Главный кормилец казино (`stats.totalLost`)
  3. Холодная голова (`stats.maxCrashMultiplier`)
  4. Король ласт-додепов (`stats.lastDodepWins`)
  5. Главный должник чата (сумма активных долгов)
  6. Любимец барабана / Призрак чата (`stats.ghostCount`)
  7. Маньяк ва-банка (`stats.allInCount`)
  8. Вечный клиент кассы (`stats.zeroBonusCount`)
  9. Коллекционер чата (`uniqueCount * 5000 + recycleTotal`)
  - Внизу считается лидер по числу занятых номинаций `X/9`.

---

## 7. Фразы, живой чат и планировщик

- **Фразы (`server/phrases.ts`):** 54 категории × 40 цельных фраз = **2160 фраз**. `pickNonRepeatingPhrase(category, chat.usedPhraseKeys)` гарантирует отсутствие повторов в чате, пока не прокрутится весь пул из 40 (история хранит до 2600 ключей).
- **Триггеры живого чата (`handleTextMessage`):** 87 ключевых подстрок (`CHAT_TRIGGER_KEYWORDS`). Вероятность `CHAT_TRIGGER_PROBABILITY = 1.0` (100%), кулдаун `CHAT_TRIGGER_COOLDOWN_MS = 10 мин` на чат (в симуляторе можно обойти галочкой «Без кулдауна»).
- **Расписание (`startDailyScheduler`, шаг 20 сек, по `db.timezone`):**
  - **12:00** — Напутствие дня на весь чат (`dailyGuidance`, 1 сообщение без кнопок).
  - **12:01** — Доска позора и почёта (`buildLeaderboardText`).
  - **21:00** — Вечерняя сводка за 24 часа (`buildEveningSummaryText`, сравнивает с `player.dailyBaseline` и сбрасывает baseline на следующие сутки).
- **Автоудаление:**
  - `sendDice` стикеры (`🎲`/`🎰`) удаляются через **8 сек** (`scheduleCleanupMessage`).
  - Все tracked-сообщения бота (и в Telegram, и в симуляторе) старше **5 минут** (`BOT_MESSAGE_TTL_MS`) автоматически удаляются фоновым циклом (каждые 8 сек).

---

## 8. REST API сервера (`server.ts`)

- `GET /api/status` — статус Telegram-бота, таймзона, `zonedNow`, `catalogStats`, список чатов с игроками/долгами, последние 150 логов.
- `POST /api/bot/config` — обновление `timezone` и/или `TELEGRAM_BOT_TOKEN` с рестартом бота.
- `POST /api/bot/restart` — перезапуск Telegram-бота.
- `GET /api/sim/messages?chatId=sim-chat-1` — сообщения симулятора, последний тост, игроки и активные лобби Русской рулетки.
- `POST /api/sim/command` — эмуляция `/start`, `/menu`, `/top`.
- `POST /api/sim/message` — эмуляция текстового сообщения в чат (`bypassCooldown`, `forceTrigger`).
- `POST /api/sim/callback` — нажатие inline-кнопки в симуляторе.
- `POST /api/sim/set-zero` — обнулить баланс активного игрока (для теста бонуса/долга).
- `POST /api/sim/clear` — очистить ленту симулятора и переотправить `/start`.
- `POST /api/broadcast/test` — ручной триггер рассылок (`type`: `'horoscope' | 'leaderboard' | 'both' | 'evening' | 'all'`, `includeTelegram`: boolean).
- `POST /api/phrases/sample` — случайная цитата и напутствие для вкладки «Фразы и напутствие».

---

## 9. Инварианты и памятка на будущее (Gotchas)

1. **При добавлении новой игры:**
   - Добавить тип в `GameType` (`server/storage.ts`), кнопку в `buildMainMenuKeyboard()`, заголовок/правила в `GAME_TITLES` / `GAME_RULES_SHORT`, ветку в `startGameFlow()` и обработчик в `handleCallback()` (`server/botEngine.ts`).
   - Обязательно вызывать `deductPlayerStake(player, stake)`, `scheduleSave()`, обновлять `lastBetAmount` / `lastGameType` / `lastActionWasLoss` / `lastDodepWins`, а при чистом выигрыше — вызывать `await applyAutoDebtCollection(transport, chat, player, netProfit)`.
   - Использовать `buildPostGameKeyboard(...)` для кнопок «Ласт додеп (x2)» / «Повторить» / автоподстановки «Бонус при нуле» при сливе до 0.
2. **При добавлении нового мультиплеер-лобби или долгоживущего сообщения:**
   - Добавить проверку его `messageId` в `isProtectedInteractiveMessage(msgId)` (`server/botEngine.ts`), чтобы `/start` или кнопка `menu` случайно не затёрли/не удалили активное лобби.
3. **При добавлении новых категорий фраз:**
   - Держать ровно **40 готовых цельных фраз** в массиве (стиль: кент-лудик / ауф-философия, без «лего-склейки») — тогда `getPhraseCatalogStats()` и вкладка `PhrasesView` останутся консистентными.
4. **Telegram-специфика:**
   - Чтобы бот видел триггер-слова в групповых чатах, в `@BotFather` должен быть выключен Group Privacy (`/setprivacy → Disable`) или бот должен быть админом группы.
   - `editMessage` в `telegramBot.ts` специально игнорирует `message is not modified` / `MESSAGE_ID_INVALID`.
   - `callback_data` строго ≤ 64 байт.
   - `answerCallback` обрезает `text` до 195 символов.
5. **Дизайн веб-UI:**
   - Строго 3-зонная шапка (`Дядя Деп` · 4 вкладки · 1 CTA «Тест рассылки 12:00»), спокойная светлая тема `slate-50` с тёмным чат-окном `slate-900` только внутри симулятора.
