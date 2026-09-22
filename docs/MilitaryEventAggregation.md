# Гражданские предупреждения и сохранённые сообщения

Обновлено 22.09.2026. Этот проход связывает существующие источники с картой гражданских предупреждений. Он не реализует объединённое слежение за движением вооружений, прогноз маршрута или определение неизвестного источника звука.

## Единый путь чтения

```text
Public Telegram / RSS → существующий /api/news → worker news
                                                ├─ NEWS_EVENT (совместимость)
                                                └─ civilian-reports.js
GDELT / War-Tracker civil alerts / alerts.in.ua → /api/world/conflicts → worker
                                                ↓
                           ontology + intelligence_observations
                                                ↓
       /api/world/conflicts?bbox=…&hours=1|6|24 → MapLibre
                   AirThreatService → кластеры / evidence / World Replay
```

Запрос карты с bbox читает PostgreSQL, **не вызывает внешний global fetch**. Запрос без bbox сохраняет прежний контракт worker. Внешние источники не опрашиваются на каждом перемещении карты.

## Live Alerts

Повторно используются существующие public Telegram/RSS reader, cache/coalescing, cross-post dedup и bounded place resolver. Новый scraper или geocoder не добавлен. Связка автоматически извлекает явную гражданскую формулировку предупреждения и сообщения «слышали» на EN/RU/UA из заголовка (300 символов) и первых двух абзацев (400 символов).

Типы извлечения: AIR_RAID_ALERT, ALL_CLEAR, DRONE_THREAT, MISSILE_THREAT, HEARD_EXPLOSION, HEARD_SOUND. Неизвестный шум не становится взрывом или дроном. Одно упоминание дрона/ракеты и сообщения о перемещении не создают такое предупреждение. Классификатор консервативен и может пропускать подходящие сообщения; оригинал остаётся в Live Alerts. Это **не полная реализация всех ранее запрошенных военных подтипов**.

Для новости сохраняется прежний canonical object: source:news + hash исходного URL. Извлечённое сообщение становится observation того же объекта. Повторный polling не меняет тип объекта туда-обратно и не создаёт property-history шум. Source class PUBLIC_REPORT, evidence REPORTED в provenance, numeric confidence неизвестна. Сохраняются original text/title (bounded), URL, source time, provider, matched terms, classifier version, carriers и source family. Существующая группировка перепечаток переиспользуется; число carriers не означает независимые подтверждения.

## War-Tracker и доступ

Проверены [developer page](https://war-tracker.com/blog/developers) и [OpenAPI](https://war-tracker.com/api/v1/openapi.json), 22.09.2026. Страница описывает свободный доступ; OpenAPI отдельно указывает browser allowlist / x402 для automation / partner key. Поэтому обязательный **локальный** key gate снят, но универсальный бесплатный доступ не обещается.

Адаптер запрашивает документированный `event_type=Air raid alert`, окно 24 часа, до двух страниц по 100 записей. Next cursor передаётся отдельно, как требует API. Разрешены только гражданские warning types. Optional WAR_TRACKER_API_KEY остаётся server-side; HTTP 401/402/403 означает ACCESS_REQUIRED. Нет платежей, spoofed Origin, обхода ограничений или скрытых endpoint.

Транспорт ограничен одним HTTPS host, 15 секундами, 64 KiB заголовков и 2 MiB JSON. Увеличенный bounded header budget исправляет воспроизведённый Node HEADERS_OVERFLOW. Redirects не выполняются. Cache/coalescing 180 секунд, backoff и дневной budget 500 cycles сохраняются.

alerts.in.ua требует персональный token. Его explicit threat_types участвуют в фильтрах вместе с primary subtype: AIR_RAID_ALERT + DRONE_THREAT виден в двух группах без дублирования записи. UkraineAlarm / Israel остаются access/documentation dependent. Detector AERO не подключён: [условия](https://detector-aero.ru/terms) требуют разрешения на автоматическое использование.

## География, время и покрытие

- Картографическая точка — район, указанный в сообщении; не измеренная позиция объекта. Прежний place resolver используется только при подтверждённой locality/region привязке. Country anchor не становится marker инцидента. Новые GDELT country-level records также не рисуются на country centroid.
- Записи без геопривязки возвращаются отдельно как bounded **мировая лента без AOI match**. Они не увеличивают число точек в viewport и не вытесняют геопривязанные события из map limit.
- Исходное время не исправляется на догадку о часовом поясе. GDELT с опережением до 20 минут удерживается в ограниченном process buffer и допускается только после наступления source time. Перезапуск очищает buffer; уже сохранённая история остаётся.
- Map window 1/6/24 часа; marker показывает время сообщения и возраст. Статус текущей официальной тревоги определяется отдельной existing official-state моделью, не наличием старого marker.
- Нет сообщений ≠ отбой. Состояние провайдера ≠ полнота покрытия. API/UI показывают недоступность, credential state, cap и отсутствие данных.

## Значки и звук

WebGL sprites: drone, rocket, warning, impact, sound, all-clear. Значок передаёт **формулировку источника**, не обнаруженный аппарат. Cyan halo — визуальная подсветка района сообщения о звуке (32 экранных пикселя); это не километры, дальность слышимости, опасная/безопасная зона. Existing acoustic clusters показывают область нескольких сообщений с явной DERIVED provenance.

HEARD_SOUND / HEARD_EXPLOSION не допускаются к вычислению неизвестной позиции источника. `sound_source_position_known=false` блокирует также ошибочное использование representative point в прежней сценарной acoustic модели. Прежний optional forward-scenario для уже известного события не сертифицирует реальную слышимость.

## API и ограничения

`GET /api/world/conflicts?bbox=west,south,east,north&hours=1&limit=300&cursor=…`

Внутренний сервис: `GET /intelligence/reports` с теми же параметрами. Только hours 1/6/24, limit 1..500. Cursor содержит timestamp + UUID, фиксирует верхнюю границу времени и связан с bbox/hours. SQL parameterized, timeout 4 секунды, ответ основной страницы до 2 MiB; отдельно до 20 unlocated records. Время и spatial filter применяются **до** result limit. Existing timestamp/partial air-report/GiST indexes переиспользуются; новая миграция не требуется. Docker runtime cache теперь имеет writable persistent volume: Nominatim не теряет накопленный bounded cache при пересборке.

Карта: debounce 800 ms, polling 120 секунд; на cap предлагает сузить район/время. Graph/Evidence используют существующий canonical UUID без повторной регистрации объекта. History и Replay читают те же observations. Пути/траектории из последовательности сообщений не строятся.

Source health содержит bounded diagnostics для feed:news и feed:world-conflicts: fetched, classified, geolocated, observation_upserts, checked_at, scope; upserts включают повторные записи и не являются числом новых фактов. UI раскрывает состояние доступных feeds, API отдаёт diagnostics. Raw секреты отсутствуют.

## Проверка

Fixtures проверяют EN/RU/UA, отрицательные и неоднозначные случаи, неизвестный звук, keyless attempt / access refusal, compound threat filters, часы источника, отсутствие global fetch в map read. PostgreSQL-тесты проверяют canonical identity, dedup, отсутствие лишних property changes, AOI до limit, cursors, unknown location, evidence и включение в AirThreatService / Replay. Live providers не требуются для CI. Результаты запуска и ограничения реального smoke фиксируются в Workflow/Log.md.


## Реальный smoke 22.09.2026

В 12:43–12:46 МСК production: GDELT 75 записей / 61 с координатами / 75 observation upserts; Live Alerts 108 сообщений / 0 явных гражданских warning или auditory формулировок / 0 новых warning observations. Это не означает отсутствие угрозы и не покрывает все региональные каналы. War-Tracker вернул HTTP 402 (ACCESS_REQUIRED); alerts.in.ua KEY_REQUIRED. Никакие production fixtures не добавлялись.

Retained map read: Восточная Европа — 10 сообщений за 1 час и 46 за 6 часов, Ближний Восток — 122 за 6 часов. HTTP 34–77 ms на проверенных bbox; SQL EXPLAIN ANALYZE 1.111 ms, Bitmap Index Scan по intelligence_history_geo и partial air index. Это измерения небольшой реально накопленной БД, не обещание такой скорости при любом объёме. GDELT reporting timestamp может относиться к обработке старой статьи: он не доказывает время самого события.

Browser подтвердил WebGL clusters и markers, ограничение 300 записей, окно 6 часов, карточку source metadata и Evidence по прежнему UUID. Реальных auditory warnings в текущей ленте не было: sound halo и EN/RU/UA warning extraction проверены fixtures; живое воспроизведение sound report не заявляется.

Старые сохранённые GDELT observations остаются неизменными, включая прежние generic MILITARY_STRIKE labels и неполные precision metadata. Новые generic CAMEO records нормализуются как CONFLICT_EVENT; сведения источника в evidence имеют приоритет перед названием. Это ограничение прежних данных, а не подтверждение каждого показанного удара.

Дополнительно browser smoke: History открывается сразу на нужной вкладке; Jump to global timeline переключает выбранный timestamp; Return to Live сохраняет Case context и включённые layers.
