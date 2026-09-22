# Intelligence layer: история, источники и корреляции

Слой развивается поверх Persistent Ontology V1. UUID, external identifiers, typed links, `/resolve`, карта и существующие resolvers сохранены. Новые события не генерируются LLM. Корреляция означает связанные сигналы или потенциальный риск, а не причинность, ущерб или подтверждённую атаку.

## Запуск и обновление

```powershell
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://localhost:4000/health
Invoke-RestMethod http://localhost:3000/api/intelligence/policies
```

Интерфейс: http://localhost:3000. Обычный запуск после пересборки: `docker compose up -d` — существующий desktop launcher не меняется. Используется тот же PostgreSQL и Docker volume. Не удаляйте volume и не выполняйте `down -v` для обновления. Отдельные PostgreSQL, WSL и Linux shell на Windows не нужны.

Миграция `003_intelligence.sql` выполняется один раз под advisory lock в транзакции существующего migration runner. Повторный запуск не пересоздаёт таблицы. Существующие V1 Observation nodes сохраняются и копируются в timeline. Новые GPS updates хранятся только в timeseries. При объединении ontology identities история, текущие координаты и fingerprint корреляций следуют за canonical UUID.

Переменные Compose:

| Переменная | Default | Назначение |
|---|---|---|
| `INTELLIGENCE_WORKER` | `1` | Сбор существующих feeds и вычисление правил; `0` выключает фоновый worker |
| `HISTORY_TELEMETRY_DAYS` | `14` | Хранение POSITION/AIRBORNE/ON_GROUND |
| `HISTORY_RETENTION_DAYS` | `90` | Остальные observations; минимум 1, максимум 3650 дней |
| `INTELLIGENCE_REPORT_KEY` | `osiris-local-reports` | Локальный development shared secret для server-to-server health reports |
| `INTEL_URL` | адрес intel в Compose | Только сервер Next; не `NEXT_PUBLIC_*` |
| `OSIRIS_INTERNAL_URL` | `http://osiris:3000` | Только intel worker; фиксированный доверенный сервис |

Для доступной извне установки задайте собственный report key через окружение. Это локальное приложение без новой многопользовательской модели авторизации; intel опубликован только на loopback. Реальные ключи в Git не добавляются.

## Архитектура и storage

```text
Существующие /api/flights, maritime, earthquakes, fires, weather, news, cyber…
   → ограниченный worker osiris-intel
   → адаптеры feeds → ontology UUID + time-series observations
   → deterministic rules → persistent correlations + evidence snapshots

Upstream fetch / cachedSource / проверка выбранной камеры
   → internal source-reports → Source Registry + последние 100 проверок

Next allowlisted API proxy → Graph HISTORY / Evidence / Source Health / Correlations
   → выбранное наблюдение или корреляция → существующая MapLibre карта
```

Новые таблицы:

| Таблица | Назначение |
|---|---|
| `intelligence_observations` | Object UUID, тип события, source time/received time, JSONB data, координаты, confidence, provenance, validity, fingerprint и retention |
| `intelligence_object_locations` | Последняя известная точка объекта или координата reference catalog; одна строка на UUID |
| `intelligence_sources` | Provider/service/camera registry, policy, enabled, счётчики, времена, backoff |
| `intelligence_source_samples` | Не более 100 последних реальных проверок на источник |
| `intelligence_correlations` | Правило/version, fingerprint, связанные UUID, strength, ACTIVE/EXPIRED/DISMISSED, временное окно, география, rationale |
| `intelligence_correlation_evidence` | Копии фактических оснований; сохраняются после удаления исходных observations по retention |
| `intelligence_correlation_events` | Переходы lifecycle и их причины |

`ontology_provenance` дополнен `source_record_id`, `extraction_method`, `confidence_basis`; допустим `imported`. Старый `reported` поддерживается и отображается как IMPORTED. Снимки свойств хранятся в `metadata.properties`, поэтому спорные значения можно сравнить по источникам, даже если текущие свойства объекта уже обновились.

Индексы: object+timestamp+UUID, event type+observed time, retention, source+checked time; GIN по связанным UUID корреляций. Для spatial prefilter используется встроенный PostgreSQL `point` с GiST, затем точное расстояние по формуле haversine. PostGIS не требуется.

## История и provenance

Поддержаны POSITION, изменения OBJECT/PROPERTIES/RELATIONSHIP, EARTHQUAKE, FIRE, SEVERE_WEATHER, WEATHER, CYBER_INDICATOR, геопривязанные NEWS_EVENT. Смена source-reported `on_ground` создаёт DERIVED AIRBORNE/ON_GROUND; это не утверждение о фактическом взлёте/посадке между редкими измерениями.

- Aircraft: ICAO24 существующего объекта сопоставляется с OpenSky/adsb.fi. OpenSky `time_position` и adsb.fi `now - seen_pos` сохраняются; время HTTP не подставляется вместо измерения.
- Vessel: MMSI и `MetaData.time_utc` AISStream. Без AIS key/доступных positions новые наблюдения не создаются.
- IP/network: IP и ASN в одной записи Feodo дают точную структурную связь ANNOUNCED_BY. Country centroid не используется как точная геолокация инфраструктуры. Индикатор не означает компрометацию владельца ASN.
- News: только опубликованное время и разрешённый settlement; country/region anchors не становятся точным местом события. Метод геопривязки явно DERIVED в metadata. Новостные ключевые слова не запускают правила риска.
- GPS глобального фида не создаёт тысячи новых identities: отслеживаются до 300 уже зарегистрированных Aircraft/Vessel за цикл. До одного POSITION на объект в минуту; polling обычно раз в 2 минуты.

Evidence state:

| State | Значение |
|---|---|
| OBSERVED | Источник передал наблюдение с исходным timestamp, например ADS-B position |
| IMPORTED | Перенесённая запись/reference/утверждение внешнего источника |
| DERIVED | Вычисление из явно указанных данных, включая weather model и correlation rule |
| INFERRED | Предположение/эвристика, например V1 candidate name match |

Numeric confidence копируется только при наличии значения источника; иначе `null` / **Not provided**. Categorical FIRMS confidence остаётся исходной строкой, не преобразуется в выдуманные 0.94. Старые распознаваемые маркеры V1 `0.5` для inferred совпадений очищены с сохранением объяснения. Межисточниковые шкалы не объявляются сопоставимыми вероятностями.

Без source timestamp аудит изменения помечен **RECEIVED**. При просмотре timeline показываются source, state, confidence, properties, observed/fetched time. Координаты можно открыть на карте. Track строится максимум по 200 загруженным POSITION; разрывы более 30 минут и переходы через линию смены дат не соединяются. Линия между измерениями не считается наблюдённым маршрутом.

## Source health и freshness

Статусы определяются по реальным попыткам, а не cache hits:

- UNKNOWN: ещё нет проверки либо источник disabled.
- DEGRADED: 1–4 последовательных ошибки или менее 80% успехов в последних 100 проверках.
- OFFLINE: 5 и более последовательных ошибок.
- STALE: последняя успешная проверка старше fresh threshold, при отсутствии текущей серии ошибок.
- HEALTHY: свежий успех и достаточная доля успехов. Успех сбрасывает consecutive failures; накопленная плохая доля восстанавливается постепенно.

Отдельно показывается свежесть **данных**. Успешный HTTP с историческим feed может иметь HEALTHY / HISTORICAL. Если source time отсутствует, freshness UNKNOWN; fetched time не выдаётся за observation time. Пример thresholds в секундах:

| Категория | LIVE ≤ | FRESH ≤ | HISTORICAL после |
|---|---:|---:|---:|
| Aircraft | 120 | 300 | 86400 |
| Maritime | 120 | 600 | 86400 |
| Weather | 900 | 3600 | 86400 |
| Fire | 900 | 21600 | 172800 |
| Earthquake | 300 | 86400 | 604800 |
| CCTV | 300 | 900 | 86400 |
| Ontology | 3600 | 86400 | 2592000 |
| Static catalog | 86400 | 2592000 | 31536000 |

Между FRESH и HISTORICAL — STALE. Полная таблица: `policy.js` и `/api/intelligence/policies`. Registry `policy` допускает override live/fresh/historical при первоначальной регистрации источника; существующие overrides сохраняются и могут изменяться администратором в PostgreSQL. Общие thresholds меняются в `POLICIES`; правила риска — в `THRESHOLDS` с повышением rule version при изменении семантики.

Provider, агрегированный OSIRIS service и камера различаются полем scope. Проверка камеры принимает только ID существующего каталога, только snapshot feed, проверяет DNS/private addresses, запрещает redirects и произвольные URL, ограничивает frame 2 MB и timeout 8 s. HTML вместо image считается ошибкой. Проверяется доступность frame, а не его оптическая свежесть; frozen image пока не определяется. Iframe/HLS остаются UNKNOWN. Не более двух одновременных проверок, 12 запросов в минуту на клиента, повтор успешной камеры через 10 минут. Ошибки увеличивают backoff до часа; состояние переживает restart. Registry камер ограничен 2000 проверявшимися камерами.

**Healthy only** выключен по умолчанию. При включении на карте остаются только недавно проверенные healthy cameras; UNKNOWN тоже исключаются. Каталог с тысячами камер не вызывает массовые frame probes.

## Correlation rules и confidence

| Правило | Условия V1 |
|---|---|
| FIRE_WEATHER_INFRA_RISK | Пожар ≤6 ч; infrastructure/airport/port ≤30 км; wind model ≤1 ч и ≤20 км от пожара; ветер ≥5 м/с, направление *к* объекту ±45° |
| EARTHQUAKE_INFRA_RISK | USGS magnitude ≥5, возраст ≤24 ч, infrastructure/airport/port ≤150 км |
| EARTHQUAKE_TSUNAMI_PORT_REVIEW | Те же magnitude/возраст, порт ≤500 км, источник явно передал tsunami=1; только повод проверить официальную информацию |
| SEVERE_WEATHER_AVIATION_RISK | Severe/high report ≤6 ч и не истёк; airport или aircraft ≤100 км; aircraft position ≤5 мин |
| FIRE_FLIGHT_OPERATIONS_RISK | Условия fire+wind, airport/aircraft; FIRMS FRP ≥50 MW и visibility <5000 м. Причина плохой видимости и нарушение полётов не утверждаются |
| CYBER_INFRA_RELATED_SIGNAL | Активный индикатор ≤24 ч и exact ontology link ANNOUNCED_BY/HOSTED_BY/AFFECTS; inferred/name-only links не принимаются |

Wind direction API — направление **откуда** дует ветер; правило использует `(from + 180) mod 360`. Open-Meteo current conditions являются модельными, evidence DERIVED. Эти условия — инженерные screening heuristics, не физическая модель распространения пожара и не расчёт ущерба. Основание: [Open-Meteo documentation](https://open-meteo.com/en/docs), проверено 21.09.2026.

USGS `tsunami` не подтверждает реальное или предсказанное цунами. UI прямо предлагает проверить NOAA/local authorities; самостоятельного прогноза нет. Основание: [USGS ComCat](https://earthquake.usgs.gov/data/comcat/) и [GeoJSON feed](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php), проверено 21.09.2026.

Strength означает силу поддержки **правила**, не вероятность вреда:

- HIGH: источники не inferred, есть минимум два различных provider и расстояние ≤половины допустимого радиуса; либо cyber exact identity + допустимая reported/imported связь.
- MODERATE: остальные допустимые совпадения. Неизвестные/недостающие обязательные поля приводят к отсутствию совпадения.
- LOW зарезервирован, текущие правила его не выдают. Numeric correlation confidence всегда null.

Список различных providers — технический proxy разнообразия источников, не доказательство их редакционной/методологической независимости. WHY THIS WAS FLAGGED показывает distance, age, направление/скорость, thresholds, исходные записи и provenance.

Fingerprint: SHA-256(type, rule version, trigger UUID, target UUID). Повтор polling обновляет last_confirmed и evidence; новый duplicate не появляется. ACTIVE → EXPIRED при старении любого обязательного доказательства или когда обработанный seed больше не проходит правило. Если оценка была усечена лимитами, отсутствие в результате не используется для массового закрытия других сигналов. EXPIRED означает отсутствие актуального подтверждения условия, а не безопасность. DISMISSED сохраняет evidence и не активируется повторно автоматически. История переходов сохраняется; удаление raw observations не удаляет correlations.

## Ограничения нагрузки

Worker: тик 15 секунд, до двух источников одновременно, очередь с ротацией. Aircraft/maritime/earthquake обычно 120 с, weather/news 300 с, fires/cyber/satellite 600 с, CCTV catalog 1800 с, reference catalog 6 ч. Retry exponential capped 1 ч. Фактический цикл может быть длиннее при медленных источниках. Wind: максимум 8 подходящих точек за 10 минут, один batch API request.

Event ingest ≤200 последних записей feed за цикл, транзакции по 25. Correlation evaluation не чаще минуты: ≤250 recent seeds, ≤5000 spatial assets, ≤250 weather records, ≤1000 cyber links, ≤500 результатов. Это ограниченное покрытие, а не полный глобальный мониторинг. GPS minute sampling/retention и индексы ограничивают рост. Prune удаляет до 5000 истёкших observations в час; большие установки должны настроить retention/частоту обслуживания. Source samples ограничены 100 строками. Correlation lifecycle и ontology event identities сохраняются для расследования; автоматического удаления этих identities пока нет.

UI polling — 60 секунд, history API ≤200 событий на страницу (UI 50), на экране максимум 500. Graph limits V1 остаются: depth ≤4, nodes ≤250, links ≤500.

## API

Public Next proxy (`:3000`):

| Метод / путь | Параметры / результат |
|---|---|
| GET `/api/ontology/objects/:uuid/history` | from/to ISO, limit 1–200, order asc/desc, cursor, location_only true/false. Default 90 дней, максимум 366 |
| GET `/api/ontology/objects/:uuid/provenance` | property optional; до 100 provenance snapshots |
| GET `/api/intelligence/policies` | Freshness, rule thresholds, confidence policy |
| GET `/api/intelligence/sources` | scope provider/service/camera/all, category, status, cursor, limit ≤200 |
| GET `/api/intelligence/sources/:id/samples` | limit ≤100; bounded actual checks |
| GET `/api/intelligence/correlations` | status ACTIVE/EXPIRED/DISMISSED/all, type, object_id, cursor, limit ≤100 |
| GET `/api/intelligence/correlations/:uuid` | objects, evidence snapshots, rationale, lifecycle |
| POST `/api/intelligence/correlations/:uuid/dismiss` | Без тела; локальное явное действие пользователя |
| POST `/api/intelligence/camera-check?id=…` | Только ID текущего CCTV каталога |
| GET `/api/intelligence/catalog` | Уже существующие airport/infrastructure reference catalogs |

Backend (`:4000`) использует те же suffix без `/api`. `POST /ontology/observations` принимает object_id, event_type, observed_at, lat/lon optional, data, provenance, valid_from/to; возвращает observation_id/storage=history. `/ontology/ingest` сохранён. `POST /intelligence/source-reports` требует `X-Intelligence-Key`, batch 1–50. Internal reports и arbitrary ingest не выставлены frontend proxy. GET `/intelligence/sources/:id` нужен серверному camera backoff. Внешние URL никогда не принимаются как fetch target этих API. SQL values parameterized; malformed input 400, missing object 404, bounds/rate/concurrency limits обязательны.

## Интерфейс

1. Map object → **Explore relationships**, либо **ONTOLOGY** → найти объект. Справа **HISTORY**, **DETAILS / EVIDENCE**; нажать ребро для основания связи.
2. В HISTORY задать диапазон, **Apply / refresh**, **Load next 50**. **Locate** фокусирует карту; **Show loaded track on map** показывает ограниченный исторический track.
3. **SOURCE HEALTH** показывает provider/service/camera, health и freshness отдельно. Камера → **Check source health**. Healthy only включается по желанию и имеет кнопку clear на карте.
4. **CORRELATIONS** → сигнал → WHY THIS WAS FLAGGED, evidence, источники, lifecycle. **Show on map** рисует только выбранную связь; **Graph: …** открывает объект по canonical UUID. **Dismiss signal** сохраняет историю.
5. **Clear map highlight** убирает временное выделение. Постоянная паутина связей на карте не создаётся.

## Расширение и проверки

Новый feed: добавить фиксированный endpoint в `worker.FEEDS`, normalization в `feeds.js`, исходные IDs/timestamps и provenance. Никакого name-only identity. Новый event_type не требует новой колонки. Новое правило — pure function в `rules.js`, версия, обязательные входные данные, expiration, fingerprint, positive/negative/freshness/missing-data tests. Новые Object/Link Types добавляются через registry `ontology/model.js`, как в V1.

```powershell
npm test
npm run build
docker compose exec -T osiris-intel npm test
powershell -ExecutionPolicy Bypass -File tools/intelligence-smoke.ps1
```

Backend tests создают уникальные временные schemas в существующем PostgreSQL и удаляют только их; production schema не очищается. Источник fixtures явно тестовый. HTTP smoke не добавляет выдуманные данные в рабочую базу. Известный Windows locale failure `4,200 km` описан в `Workflow/BugLog.md`.

Для проверки положительного UI-сценария есть `intel/ontology/test/ui-fixture.cjs`. Он запускается только с `INTELLIGENCE_UI_FIXTURE=1` в отдельном intel-процессе; создаёт собственную schema `intelligence_ui_<uuid>`, помечает все объекты `UI FIXTURE`, при SIGTERM удаляет только эту schema. Отдельный frontend должен направлять `INTEL_URL` на этот процесс и отключать reporting. Это тестовый harness, не production seed.

Порог freshness задаётся JSONB policy источника (секунды live/fresh/historical) или defaults в `intelligence/policy.js`; порядок порогов валидируется. Сохранённые overrides переживают повторную регистрацию. `enabled=false` отключает активный polling соответствующего feed или Open-Meteo; пассивная статистика реальных пользовательских запросов может продолжать приходить. Верхние лимиты расчёта не считаются доказательством исчезновения корреляции: при усечённом наборе закрытие по отсутствию совпадения не выполняется, expiration исходных данных сохраняется.

## Изменённые файлы

- Backend: `intel/intelligence/{policy,history,health,rules,correlations,identity,feeds,worker,routes}.js`; `intel/ontology/migrations/003_intelligence.sql`; интеграция в `intel/server.js`, `intel/resolvers.js`, `intel/ontology/{model,store,observations,routes,sources,fetch-source}.js`.
- API: новые `src/app/api/intelligence/{[...path],catalog,camera-check}/route.ts`; обновлены `src/app/api/ontology/[...path]/route.ts`, routes flights/maritime/earthquakes/fires/weather/satellites/cyber-attacks.
- UI: новые `ObjectHistory`, `EvidenceView`, `SourceHealthPanel`, `CorrelationsPanel`, `IntelligencePanelShell`; интеграция в `EntityGraphPanel`, `CameraViewer`, `OsirisMap`, `src/app/page.tsx`.
- Общие модули: `src/lib/{intelligence,investigation-map,source-health-reporter,telemetry-time}.ts`; изменены `ontology.ts`, `sourceCache.ts`, `stealthFetch.ts`.
- Проверки: `intel/ontology/test/intelligence-{model,persistence,worker}.test.js`, `ui-fixture.cjs`, изменён `persistence.test.js`; новые frontend API tests и `src/lib/{investigation-map,telemetry-time}.test.ts`; `tools/intelligence-smoke.ps1`.
- Развёртывание/документация: `docker-compose.yml`, `intel/Dockerfile`, `README.md`, `docs/{Intelligence,Ontology}.md`, `docs/Workflow/{Log,BugLog}.md`.

Ограничения: отслеживание начинается после регистрации объекта; задним числом полный маршрут не восстанавливается. Положительные корреляции появляются только при подходящих реальных данных. Каталог инфраструктуры конечный. AIS требует ключ. Внешние сбои, включая OpenSanctions, видны в Source Health. Iframe video и frozen-frame detection не проверяются. Правила не заменяют официальные предупреждения и не дают прогноза ущерба.

### Раздельное здоровье CCTV (22.09.2026)

`intelligence_sources.camera_media` хранит результат snapshot отдельно от stream. ID-only camera-check подтверждает только полученные image bytes; видео остаётся UNKNOWN и проверяется браузером. Это также относится к HLS-камере с отдельным JPEG. Healthy only использует свежий успешный кадр, не обещает video playback. Подробности, безопасность и реальные проверки: [CctvPlayback.md](CctvPlayback.md).
