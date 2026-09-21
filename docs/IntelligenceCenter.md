# Intelligence Center и расследование объектов карты

Этот проход развивает существующие PostgreSQL ontology, history, provenance, source health и correlation engine. Graph renderer, resolvers, reverse traversal и canonical UUID сохранены. Нового независимого backend-layer или базы данных нет.

## Использование

Справа на карте находится сворачиваемый **INTELLIGENCE CENTER**. Он показывает количество объектов, связей, observations, активных/истёкших корреляций, состояние всех источников и worker/DB. Кнопки **OBJECT EXPLORER**, **CORRELATIONS**, **SOURCE HEALTH** открывают существующие подробные панели. После выбора расследуемого объекта виден контекст **INVESTIGATING**.

Нажмите объект карты. В его popup/details есть общий блок **INTELLIGENCE**:

- **Explore relationships** — root и связи; поддерживаемые существующими resolvers объекты дополнительно обогащаются.
- **History** — сразу HISTORY, без предварительной загрузки соседей.
- **Evidence** — сразу DETAILS / EVIDENCE, provider, source record, timestamps, confidence и способ извлечения.
- **Related objects** — сохранённый граф depth=1 в обе стороны.

Обычный click не открывает Graph Explorer. Регистрация происходит после явного действия. Подробная telemetry по-прежнему сохраняется только для зарегистрированных объектов в рамках bounded worker policy. Открытие слоя CCTV или Satellites не импортирует весь каталог в ontology.

## Типы и identity

| Карта | Ontology type | Identity |
|---|---|---|
| Aircraft | aircraft | ICAO24 / registration |
| Vessel | vessel | IMO / MMSI |
| Country, Company, Person | соответствующий тип | ISO, Wikidata QID, source ID; прежний поиск кандидатов сохранён |
| IP | ip | нормализованный IPv4/IPv6 |
| Fire | event | прежний FIRMS fingerprint: исходные координаты, acquisition timestamp, provider |
| Earthquake | event | USGS event ID |
| Severe Weather | event | NWS/EONET/GDACS record ID |
| Infrastructure | infrastructure | ID существующего каталога |
| Airport | airport | ICAO/IATA; оба ID при наличии |
| Port | port | ID каталога; иначе уже применяемый worker composite key имени и исходных координат |
| Satellite | satellite | NORAD ID, ведущие нули нормализуются |
| CCTV | camera | ID локального camera catalog |
| Geolocated News/Event | event | URL источника без fragment |

Для FIRMS и Port используются **исходные координаты записи**, а не округлённые координаты vector-tile hit MapLibre. Иначе открытие marker могло бы породить другой fingerprint. Разные provider IDs сами по себе не доказывают, что события относятся к одной сущности: name-only merge не выполняется.

Нет надёжного ID — нет автоматической регистрации. Не-USGS earthquake и новости с country/region-only геопривязкой не выдаются за точные расследуемые события. Для старых Company/Person/Country сохранён прежний resolver flow с явно обозначенными кандидатами.

## Backend и API

Новые модули:

- `intel/intelligence/investigate.js`: validation, адаптация выбранной записи через существующие feed adapters, transaction, canonical object, observation при наличии исходного времени, object context.
- `intel/intelligence/summary.js`: агрегаты, worker state, shared pending request и cache на 15 секунд. UI опрашивает раз в 20 секунд, скрытая вкладка не выполняет фоновый polling.
- `intel/intelligence/correlation-pages.js`: ограниченные снимки страниц, устойчивые к обновлению `last_confirmed_at` worker.

| Public API | Назначение |
|---|---|
| `GET /api/intelligence/summary` | один ответ для всей панели; query parameters не принимаются |
| `POST /api/intelligence/investigate` | `{type,id,name?,provider?,record,...stableIdentifiers}`; максимум 32 KiB, 30 запросов/мин/IP |
| `GET /api/intelligence/objects/:id/context` | canonical object, число связей и observations |
| `POST /api/intelligence/camera-check?id=...` | только известная локальному camera catalog запись; UNKNOWN/NOT_AVAILABLE для неизвестной |
| `GET /api/intelligence/correlations?status=ACTIVE&limit=40&cursor=...` | chronological pagination; максимум 100 строк на странице |

Остальные API не менялись: `/api/ontology/objects/:id`, `/graph?depth=1`, `/expand`, `/history`, `/provenance`, `/relationships`; source health/detail/correlation evidence/dismiss сохранены.

Next проксирует только фиксированные внутренние адреса. Пользовательский URL никогда не запрашивается при registration. Camera record заменяется данными серверного каталога; frame check использует прежний SSRF guard и запрещает redirects. SQL parameterized. На backend POST требует хотя бы один стабильный ID и допустимый тип.

## Provenance

Выбранная браузером запись сохраняется как **IMPORTED**, с `client_supplied` и описанием selection. Это не независимая повторная проверка исходного provider. Source timestamp сохраняется, когда он есть; без него position observation не изобретается. Numeric confidence остаётся неизвестным, если нет обоснованного значения. Исходная FIRMS confidence сохраняется как source property, а не преобразуется в фиктивную вероятность.

Исходный worker по-прежнему различает OBSERVED/DERIVED/INFERRED/IMPORTED. Корреляция показывает поддержку правила и потенциальный риск, не причинность. Пустая история корректно сообщает `No retained observations yet for this range`.

## Storage, ordering и limits

Миграция `004_intelligence_center.sql` добавляет только таблицу `intelligence_worker_state` и индексы `(last_confirmed_at DESC,id DESC)`, `(status,last_confirmed_at DESC,id DESC)`. `camera` добавляется в существующий registry типов при повторяемой migration/bootstrap процедуре. Старые таблицы и данные сохраняются.

Worker пишет heartbeat, время завершённого цикла, последней успешной ingestion и ошибку цикла. RUNNING означает свежий heartbeat без ошибки; старше 180 секунд или ошибка — DEGRADED; явное отключение — STOPPED; записи нет — UNKNOWN. Ошибка PostgreSQL приводит к ERROR и неизвестным счётчикам, а не к нулям.

Первый запрос correlations выполняет indexed ordering `last_confirmed_at DESC,id DESC`. Cursor содержит оба значения и ID короткого снимка. Следующие страницы читаются из того же снимка: worker может подтвердить/переставить live строки, но это не теряет непросмотренные строки. Новый Refresh даёт актуальное состояние. Снимок действует 5 минут, хранит до 2,000 строк; максимум 16 снимков и 8 MiB сериализованных данных на процесс, до 4 MiB на снимок. При превышении строк возвращается `truncated`; при истечении/вытеснении — 410 с предложением Refresh. Фильтры привязаны к cursor, поддельный cursor отклоняется. После restart cursor нужно обновить.

Camera lookup использует Map с максимумом 60,000 записей и существующий disk snapshot до 32 MiB. Disk restore throttled на 30 секунд и объединяет параллельные reads. Он не вызывает `/api/cctv?region=all` и не инициирует provider fan-out. UNKNOWN не считается HEALTHY. `OSIRIS_CCTV_SNAPSHOT=off` теперь отключает и чтение, и запись.

## CI и запуск

```powershell
npm ci
npm test
npm run build
npx tsc --noEmit
docker compose up -d --build
docker compose run --rm --no-deps osiris-intel npm test
docker compose ps
```

После rebuild прежний launcher с `docker compose up -d` продолжает работать. Порт 3000, PostgreSQL 16, persistent volume, cache и dependency ordering сохранены. WSL-команды не требуются. Не выполнять `docker compose down -v`.

`.github/workflows/ci.yml` запускает frontend npm ci/test/build/TypeScript на Ubuntu и Windows (Node 22); backend npm ci/test — на Ubuntu с PostgreSQL 16 service. Тесты создают собственные schemas и действительно обращаются к PostgreSQL; недоступность DB ломает тесты. Схема сервиса соответствует [официальному руководству GitHub](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers) (проверено 21.09.2026). Реальные GitHub checks появятся после push ветки; этот проход сам ничего не публикует.

`tools/check-repository-artifacts.mjs` проверяет отсутствие tracked node_modules, `off`, `.cache` и наличие обоих package-lock.json. Runtime dependencies удалены из Git index, локально установленные пакеты сохранены. Locale-тест сравнивает числовое значение и единицы независимо от разделителя тысяч; пользовательское форматирование не менялось.

## Расширение

Новый map type подключается в `mapEntitySeed`, backend `investigationInput` и registry `OBJECT_TYPES`, если нужен отдельный ontology type. Используйте `InvestigationActions` в popup/details; передавайте исходные record/coordinates и стабильные ID, добавляйте normalization/dedup tests. История использует существующие `writeObservation` и provenance; новые внешние probes не нужны.

## Ограничения

Каталоги и источники конечны; отсутствие связей не означает отсутствие реальных отношений. Satellites показывают расчётное положение SGP4, а не измеренную telemetry. Поддержка airports на карте относится к существующим markers аэропортов наблюдаемых маршрутов; новых datasets не добавлено. News actions доступны геопривязанным Live Alert Pins; эфирные news channels не являются событиями. Source counters могут отставать от detail на 15 секунд. История начинается с регистрации и сохраняется в рамках retention. Внешние outages и старый lint debt отслеживаются в `docs/Workflow/BugLog.md`.

## Проверка реализации — 21.09.2026

- Baseline перед изменениями: 832 frontend passed, 20 skipped, 1 locale failure; backend 49/49 на PostgreSQL. Locale failure устранён в тесте без изменения formatDistance/formatArea.
- Итог: `npm test` — **856 passed, 20 skipped, 0 failed**. Это прежние skipped suites, новых пропусков не добавлено. Backend — **58/58, 0 skipped**, настоящие PostgreSQL schemas; проверены identity/worker compatibility, source summary, persistence, chronology/cursors/live updates, malformed input, provenance и старые ontology/intelligence сценарии.
- `npm run build` и `tsc --noEmit` успешны. ESLint всех новых модулей и затронутых небольших TS/TSX модулей — 0 ошибок/предупреждений. Полный lint старых page/OsirisMap/CameraViewer/fires сохраняет 200 прежних ошибок вместо 201 в baseline; это BUG-004, а не зелёная проверка всего проекта.
- `docker compose up -d --build`, затем обычный `docker compose up -d` успешны: frontend, intel, PostgreSQL healthy; cache running. PostgreSQL volume не удалялся. Четыре миграции применены; прежние Apple/CMP815 UUID и created_at сохранены, Apple graph содержит 27 nodes/27 links, сохранённая CMP815 history доступна.
- HTTP 200: главная, frontend/intel health, summary, graph, history, provenance, source health и correlations/detail. Summary source counts совпали с all-scope detail; worker RUNNING, DB HEALTHY. Неизвестная camera вернула UNKNOWN/NOT_AVAILABLE; malformed limits/cursors отклонены.
- Browser smoke на настоящей карте: Aircraft SXS4ZJ → Explore/History; USGS us7000tix2 → Evidence; FIRMS hotspot → Related objects (повторное открытие сохраняет UUID); GDACS Dujuan → Explore; Zaporizhzhia infrastructure → Explore; TfL A406 camera → Evidence/Check health (FRAME_AVAILABLE); satellite NORAD 49044 → Explore. Intelligence Center counters, Healthy only, correlation evidence, Graph и Show on map работают. Список содержит 5 реальных weather/airport correlations; fixtures в production не добавлялись и реальные correlations не dismiss-ились. Airport graph проверен из correlation. Port/News mapping и registration покрыты тестами; живые news pins во время UI-проверки отсутствовали.
- GitHub workflow подготовлен, но удалённые checks не запускались: commit/push не выполнялись. Ветка `codex/intelligence-center` создана от исходной `feature/ontology-v1`. Проверка tracked runtime artifacts и `git diff --check` с учётом CRLF проходит.

## Изменённые файлы

- Cleanup/CI: `.gitignore`, `.dockerignore`, `.github/workflows/ci.yml`, `tools/check-repository-artifacts.mjs`; `off` и tracked `intel/node_modules/**` удалены из index, lockfiles сохранены.
- Backend: `intel/server.js`, `intel/ontology/model.js`, `intel/ontology/migrations/004_intelligence_center.sql`, `intel/intelligence/{routes,worker,correlations,correlation-pages,summary,investigate}.js`.
- API/data: `src/app/api/intelligence/{[...path],investigate,camera-check}/route.ts`, `src/app/api/fires/route.ts`, `src/lib/{ontology,investigation,cctv-snapshot}.ts`.
- UI: `src/app/page.tsx`, `src/components/{IntelligenceCenter,InvestigationActions,EntityGraphPanel,ObjectHistory,CorrelationsPanel,OsirisMap,CameraViewer,SatelliteCard}.tsx`.
- Tests: `intel/ontology/test/intelligence-center.test.js`, `src/lib/{investigation,cctv-snapshot,geo}.test.ts`, `src/app/api/intelligence/{camera-check,investigate}/route.test.ts`.
- Документация: этот документ, `README.md`, `docs/Workflow/{Log,BugLog}.md`. Docker Compose и desktop launcher не изменялись.
