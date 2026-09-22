# Stage 3 — World Data Expansion

Разработка ведётся в `development`. Она создана от `ccad7d8` и уже содержит предыдущие Ontology, Intelligence Center и World Replay. Старые ветки оставлены как резервные ссылки; master/upstream не менялись.

## Использование

Откройте LAYERS. Новые группы: **CRITICAL INFRASTRUCTURE**, **WEATHER INTELLIGENCE**, **CONFLICT / AIR THREATS**. По умолчанию они выключены. Для OSM приблизьте карту: viewport не более 2° по каждой оси. Отдельные цветовые поля погоды взаимно исключаются; ветер и radar включаются независимо.

Клик по объекту открывает WORLD DATA: источник, время, точность координат, свойства, confidence и общие Explore / History / Evidence / Related objects. Развёрнутая панель также содержит несколько доступных объектов для выбора с клавиатуры. Открытие слоя не сохраняет все его объекты в ontology. Регистрация инфраструктуры и погодной ячейки происходит только по investigation action.

В Replay текущие OSM/модельные погодные точки и live conflict reports скрываются. Сохранённые observations отображает существующий temporal pipeline. Radar выбирается из реально доступных прошлых кадров RainViewer, без подмены текущим кадром. Сообщения о конфликте — последовательность **сообщений**, не маршрут БПЛА/ракеты и не подтверждённый факт поражения.

## Архитектура и API

`src/lib/world/`: типы/identity, ограниченный cache/backoff, OSM, GEM, Open-Meteo/RainViewer, conflict и optional historical enrichment. `WorldLayers.tsx` добавляет отдельные MapLibre sources и небольшую панель. `LayerPanel` использует существующие переключатели; URL layer state сохранён.

| API | Назначение / ограничения |
|---|---|
| `GET /api/world/infrastructure?bbox=W,S,E,N&categories=power,substation` | OSM + локальный GEM; categories из allowlist; OSM 500 элементов; объединённый ответ до 700 |
| `GET /api/world/weather?bbox=W,S,E,N` | Один batch Open-Meteo, до 81 координаты; zoom/quality, диагностика |
| `GET /api/world/radar` | Только metadata доступных прошлых кадров |
| `GET /api/world-radar/{time_ms}/{z}/{x}/{y}` | PNG только известного frame; фиксированный host/path; zoom <=7 |
| `GET /api/world/conflicts[?bbox=…]` | До 600 нормализованных сообщений, отдельный статус каждого provider |
| `GET /api/world/enrichment?provider=acled|ucdp&from=ISO&to=ISO&bbox=…` | Optional historical enrichment: <=31 день, <=200 записей, без минутного polling |
| `GET /api/world/providers` | Наличие adapter/credentials; секреты не возвращаются |
| `POST /api/intelligence/investigate` | Существующий endpoint принимает `type: world` и source record |

Неправильные bbox/categories/range/provider и лишние query parameters отклоняются. Arbitrary URL fetch отсутствует; redirects внешних новых адаптеров запрещены. Общий лимит world routes — 40 запросов/мин на client IP. Radar имеет отдельный общий бюджет 80 upstream tiles/мин, максимум 8 concurrent, 64 tiles в памяти до 10 минут. Архива/offline prefetch нет.

OSM cache: час, 20 viewport queries, один in-flight запрос, минимум 30 секунд между новыми запросами, локальный бюджет 100/сутки. Overpass ограничен 15 сек/32 MiB серверной обработки; ответ считывается до 8 MiB. После ошибки backoff от двух минут до часа; fallback fan-out по публичным mirrors не выполняется. Это режим локального прототипа; для многопользовательского сервиса нужен собственный provider/extract.

Open-Meteo: cache 10 минут, 24 viewport keys, <=81 точки на batch, максимум 100 новых batches/сутки на процесс. Учитывайте также существующий weather worker и условия аккаунта. Суточные бюджеты process-local сбрасываются после рестарта; это дополнительная защита, не замена upstream quotas. UI debounce 900 ms для погоды, polling 120 секунд, данные из server cache; запросов на animation frame нет.

## Storage, provenance и время

Новые таблицы и миграции не нужны: используются `ontology_objects`, `ontology_external_ids`, `ontology_provenance`, `intelligence_observations`, `intelligence_object_locations`, `intelligence_sources` и samples. `intel/intelligence/world.js` валидирует и сохраняет world records. Typed relationships, dedup, graph traversal и старые resolver APIs не менялись.

Identity: `source:osm` + `osm:node|way|relation:id`; `source:gem` + официальный GEM ID; weather — provider + выбранная координата grid; conflict — provider + source event ID. Name-only merge отсутствует. Совпадение имён между OSM и GEM не объединяет объекты.

OSM/GEM — IMPORTED; изменение записи OSM не считается временем наблюдения физического объекта. Static history использует received-time. Open-Meteo — DERIVED: `current.time` — время модельного значения, не время запуска модели; неизвестный model run остаётся null. Visibility берётся из соответствующего hourly slot и хранит отдельный valid time. Missing confidence — null / Not provided, без вычисленных процентов.

Conflict provenance — REPORTED; общий observation evidence_state остаётся IMPORTED по существующей модели, а provenance явно содержит `kind: reported`. Evidence и History показывают REPORTED для таких сообщений; смешанные/отсутствующие evidence не переклассифицируются. GDELT DATEADDED — время регистрации сообщения; SQLDATE отдельно хранит календарную дату события. Source article и precision сохраняются. Классификация War-Tracker не выдаётся за независимую проверку OSIRIS.

`CONFLICT_REPORT` добавлен в существующий Timeline как domain `conflict`, display window 6h с учётом переданного valid_to. Это окно видимости отчёта, не утверждение о продолжающемся нападении. Weather observations действуют до часа; telemetry retention не увеличен. Имеющиеся time/GiST indexes обслуживают новый тип без нового snapshot storage.

Worker читает bounded conflict feed раз в 120 секунд; GDELT upstream обновляется не чаще 15 минут. Максимум 200 records на ingestion cycle, повторения дедуплицируются. Это текущий доступный export, не полный исторический backfill. Optional ACLED/UCDP запрашиваются отдельно и попадают в ontology только при регистрации выбранного объекта.

Некоторые upstream exports содержат будущий report timestamp. Такие записи исключаются из текущего conflict feed до наступления указанного времени, без переписывания timestamp; число пропущенных будущих записей видно в provider status. Это также предотвращает попытку сохранить сообщение, которое ещё не относится к текущему времени.

OSM line/polygon/multiline geometry сохраняется до 400 vertices. Если геометрия больше, она опускается с флагом, без соединения пропущенных вершин фиктивной прямой. Pin для way/relation/GEM — representative location. Такие объекты **не попадают** в point-only proximity asset table; текущие risk rules не считают расстояние до centroid точным расстоянием до линии. Точные OSM nodes после регистрации могут участвовать в существующих fire/weather/earthquake rules. Для conflict reports новых причинных связей не создаётся.

## Проверка источников — 21.09.2026

| Provider | Доступ, условия и решение |
|---|---|
| OSM / Overpass | Публичный documented API, без auth; [правила public instances](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html), [ODbL / attribution](https://www.openstreetmap.org/copyright). Bounded local viewport, без глобального crawl. Реальный HTTP smoke успешен. |
| Open-Meteo | [Документация](https://open-meteo.com/en/docs), [условия free/commercial и quotas](https://open-meteo.com/en/pricing). Free API для non-commercial; CC BY 4.0 attribution. Customer endpoint включается явно: `OPEN_METEO_API_MODE=customer` + совместимый `OPEN_METEO_API_KEY`. Реальные текущие поля доступны. |
| RainViewer | [API](https://www.rainviewer.com/api/weather-maps-api.html), [актуальные изменения 2026](https://www.rainviewer.com/api/transition-faq.html), [Universal Blue = 2](https://www.rainviewer.com/api/color-schemes.html). Только past ~2h/10min; maxzoom 7, 100 req/IP/min; attribution, best effort, без SLA. Старые nowcast/IR не используются. |
| GEM | Только локальный официальный export с metadata конкретного release. [Лицензия](https://globalenergymonitor.org/creative-commons-license), [официальные metadata релизов](https://github.com/GlobalEnergyMonitor/gem-tracker-metadata-audit). Не скачиваем формы/CAPTCHA и не предполагаем одинаковые права для всех файлов. |
| GDELT | Повторно используется `fetchGdeltEvents`; [15-minute exports](https://gdeltproject.org/data.html), [поля и geocoding](https://data.gdeltproject.org/documentation/GDELT-Event_Codebook-V2.0.pdf). Source articles retain copyright. Реальные сообщения получены. Геокод — centroid названного места, не точная траектория/цель. |
| War-Tracker | [Страница developers](https://war-tracker.com/blog/developers) противоречит текущему [OpenAPI](https://war-tracker.com/api/v1/openapi.json): автоматизация events теперь x402/partner access, browser-free ограничен разрешёнными origins. OSIRIS не имитирует origin, не платит, не обходит ограничения. Adapter ждёт `WAR_TRACKER_API_KEY`; cursor передаётся отдельно, <=2 страниц по100, polling120s. Живой authenticated путь без ключа не проверен. |
| alerts.in.ua | [Официальная документация](https://devs.alerts.in.ua/): персональный token, conditional Last-Modified/If-Modified-Since, provider terms. `ALERTS_IN_UA_TOKEN`, иначе KEY_REQUIRED. Без source coordinates отчёт остаётся в списке, координаты не придумываются. |
| UkraineAlarm | [Доступ по заявке/договору](https://api.ukrainealarm.com/). Ключа и выданного API-контракта нет; переменная зарезервирована, статус KEY_REQUIRED / AWAITING_DOCUMENTATION. Рабочий fetch adapter не заявляется. |
| ACLED | [OAuth](https://acleddata.com/api-documentation/getting-started), [endpoint](https://acleddata.com/api-documentation/acled-endpoint), [EULA](https://acleddata.com/eula). Account-specific access/terms; username/password только server-side, токен в памяти. Historical bounded adapter; без credentials не выполняется. |
| UCDP | [Текущий API](https://ucdp.uu.se/apidocs/) требует `x-ucdp-access-token`, version 26.1; bounded date/geography request. Citation/usage по правилам dataset; не считается live feed. Без `UCDP_API_TOKEN` отключён. |
| NOAA GOES | [Официальный regional viewer](https://www.star.nesdis.noaa.gov/GOES/). Зарезервирован adapter статус NOT_CONNECTED: стабильный разрешённый image/tile contract в этом проходе не подключён; scraping viewer отсутствует. |
| Detector AERO | Документированного API/разрешения не предоставлено. NOT_CONNECTED, без scraping, hidden endpoints или обхода доступа. |

Registry создаёт source entries без фиктивных проверок: UNKNOWN до первого запроса; отсутствующие optional adapters disabled. Успех/ошибка реального запроса поступает через существующий Source Health reporter. Cache hit не считается новым upstream success.

## Локальный GEM import

Скачайте разрешённый официальный release самостоятельно. Для CSV создайте mapping JSON с `license`, `attribution`, `source_url`, `release`, `subtype` и `columns` (`gem_id`, `name`, `lat`, `lon`, плюс нужные status/operator/capacity/fuel поля). Значения columns — **точные заголовки выбранного официального файла**; id должен быть facility/project ID, не имя и не номер строки. Для power/nuclear subtype=power; для gas/oil pipelines subtype=pipeline; terminal=terminal. Если файл содержит только facility reference point, он остаётся approximate.

```powershell
node tools/import-gem.mjs "C:\Downloads\official-export.csv" "C:\Downloads\gem-mapping.json"
docker compose up -d --build
```

Importer создаёт `data/imports/gem/catalog.geojson` с license metadata; файл ignored и не включается в image. Compose монтирует `data/imports` read-only. До 20k записей, CSV <=32 MiB, runtime GeoJSON <=16 MiB; в viewport выдаётся <=500. Исходные data/catalog файлы проекта не затрагиваются. Отсутствие локального GEM файла не мешает запуску.

## Ограничения V1

- Не полная глобальная инфраструктурная база: public Overpass — локальный bounded prototype, импорт GEM опционален. Multi-user deployment требует отдельного провайдера.
- Weather — интерполированное модельное WebGL-поле и стрелки экранного размера. Один scalar color layer одновременно; ветер/radar независимы. [Настройки, диагностика и ограничения](WeatherIntelligence.md).
- Исторические radar frames доступны только в текущем окне провайдера. Глобальный архив grids/tiles не создаётся.
- Нет подтверждённого live Drone/Missile feed без разрешённого upstream доступа. Переключатели/нормализованные types готовы; отсутствие данных не заменяется вымышленными reports.
- Optional token adapters покрыты локальными проверками; authenticated production API без пользовательских credentials проверить невозможно. UkraineAlarm/GOES/Detector — обозначенные неподключённые интеграции, не готовые источники.
- Existing Carto/OpenSanctions network issues и старый large-component lint debt остаются в BugLog.

## Локальная проверка — 21.09.2026

- Frontend: 906 passed, 20 прежних opt-in skipped, 0 failed. Backend: 78/78 на настоящем PostgreSQL, 0 skipped. В CI новые backend tests автоматически включаются существующим glob.
- Production build, TypeScript и lint новых/небольших затронутых модулей проходят. Старый lint debt не скрывается — см. BugLog.
- Docker rebuild и обычная launcher-команда `docker compose up -d` проверены; frontend/intel/PostgreSQL healthy, cache running. Host port 3000 и PostgreSQL volume сохранены.
- HTTP на реальных данных: OSM Berlin viewport — 478 records / 4216 ms; Open-Meteo — 16 records / 398 ms; RainViewer — 13 frames / 554 ms и реальный PNG; GDELT — 59–69 reports, cache response 8 ms. Это отдельные smoke-замеры, не SLA или нагрузочный benchmark.
- Повторная регистрация OSM/weather/report возвращает тот же UUID; graph/history/provenance доступны. Прежние Apple/CMP815 UUID, created_at и история сохранились после upgrade.
- Browser: новые группы слоёв, model samples/wind vectors/radar, OSM и report details, Evidence/History/Graph, History → Replay проверены. В Replay live world points обнуляются; вне окна RainViewer появляется честное unavailable. Return to Live возвращает слои и сохраняет investigation context.
- Fixture-тесты GEM importer выполняются во временной папке; реальный официальный GEM dataset не предоставлен и в production не импортирован. Production smoke использует только реальные полученные записи.

Итог и ограничения также записываются в `docs/Workflow/Log.md`; удалённый GitHub Actions в этом проходе не запускался, push не выполнялся.
