# Global Timeline / World Replay

World Replay добавляет чтение сохранённого состояния во времени поверх существующих Ontology и Intelligence. Запуск прежний: `docker compose up -d --build`, затем достаточно `docker compose up -d`. Порт 3000, PostgreSQL volume и desktop launcher не меняются.

## Использование

1. Открыть **GLOBAL TIMELINE** внизу карты. В LIVE обычные слои работают как раньше.
2. Выбрать 1h / 6h / 24h / 7d либо Custom range, передвинуть slider или ввести At UTC. Custom range использует локальное время браузера, заголовок всегда UTC.
3. В REPLAY карта показывает отдельный слой Historical observations. Live overlays скрыты; их настройки сохраняются. Replay domains настраиваются отдельно.
4. Play/Pause, шаг ±1 минута и скорости 1× / 5× / 20× / 60× управляют временем: секунда реального воспроизведения соответствует выбранному количеству секунд истории. При загрузке следующего интервала воспроизведение ожидает данные; скрытая вкладка ставится на паузу.
5. Нажать маркер или выбрать retained signal: доступны исходные Evidence и существующие Explore / History / Related objects. UUID уже существует, движение slider не регистрирует новые объекты.
6. В History действие **Jump to this time on global timeline** закрывает Graph, выбирает timestamp и фокусирует карту. Выбранная observation выделена; loaded track ограничен replay range и выбранным временем. Track состоит из точек, соединяющий путь не заявляется наблюдённым.
7. **RETURN TO LIVE** очищает replay overlay и URL-параметры времени, возвращает слои без сброса investigation context.

Когда фокус внутри Timeline, вне input/select: Space — Play/Pause; Left/Right — ±1 минута; End — Live. Help обновлён. URL сохраняет `replay`, `replayFrom`, `replayTo` вместе с существующим `layers`; reload восстанавливает время. Домены и playback speed в ссылку не входят.

## Что означает историческое состояние

Это replay по **времени наблюдения** из доступных сейчас retained records, не полный аудит «что сервер уже успел получить тогда». Поздно импортированные события могут появиться в прошлом; observed и received timestamps видны отдельно. При отсутствии observed time используется received time с соответствующей маркировкой. Текущие имена объектов используются для навигации. Graph relationships и properties остаются текущей ontology — UI явно сообщает это.

Нет интерполяции, сгенерированных позиций, массовой записи telemetry или ежеминутных snapshots мира. Satellite сохраняет исходное evidence state: рассчитанная SGP4-позиция остаётся DERIVED.

| Домен | Сохранённый тип | Видимость относительно T |
|---|---|---|
| Aircraft | POSITION | Последняя позиция ≤ T, не старше 5 минут |
| Vessel | POSITION | Последняя позиция ≤ T, не старше 15 минут |
| Satellite | POSITION | Последняя позиция ≤ T, не старше 5 минут |
| Fire | FIRE | 6 часов после события |
| Earthquake | EARTHQUAKE | 24 часа |
| Severe Weather | SEVERE_WEATHER / WEATHER | valid_from/valid_to; без конца — 6 часов |
| News/Event | NEWS_EVENT | 6 часов |
| Cyber | CYBER_INDICATOR с координатами | 6 часов |
| Infrastructure / Airport / Port | REFERENCE_LOCATION | Последняя сохранённая reference location, до 30 дней |
| Correlations | lifecycle + версии evidence | Исторический ACTIVE / EXPIRED / DISMISSED; неизвестное состояние — UNKNOWN |

Интервалы полуоткрытые: `[from, to)`. Позиция, появившаяся позже за пределами viewport, отменяет предыдущую позицию внутри viewport. Отображение события в течение окна не утверждает, что физическое явление продолжалось всё это время. Для severe weather учитывается явный срок действия даже при старой дате начала. Пороговые значения централизованы в `intel/intelligence/timeline-policy.js`.

Freshness использует существующие политики `policy.js`, но возраст вычисляется относительно T. Без observed timestamp — UNKNOWN. Retention не увеличена: существующие `HISTORY_TELEMETRY_DAYS` (14) / `HISTORY_RETENTION_DAYS` (90) остаются определяющими. Это срок хранения записи после приёма; source event может быть старше. Coverage показывает фактически доступные крайние даты. Пустой результат обозначается явно; это отсутствие retained data, а не отсутствие событий в мире.

## API

Next.js проксирует только фиксированные GET paths к intel. Произвольного URL fetch нет; SQL parameterized, существующие rate limits и allowlists сохранены.

| Endpoint | Назначение |
|---|---|
| `GET /api/intelligence/timeline/state?at=...` | Состояние в точке T |
| `GET /api/intelligence/timeline/chunk?from=...&to=...` | Наблюдения и явные интервалы для playback |
| `GET /api/intelligence/timeline/events?from=...&to=...` | Хронологические страницы geolocated observations |
| `GET /api/intelligence/timeline/coverage?from=...&to=...` | Available range, до 96 buckets, domains, retention и freshness policies |

В intel те же paths без `/api`. Общие параметры: ISO timestamps с timezone, `bbox=west,south,east,north`, `domains=aircraft,fire,...`, `limit`. Dateline bbox с west > east поддержан. Неизвестные параметры, невалидные даты/диапазоны/домены/limits возвращают 400.

Events сортируются `(timeline_at ASC,id ASC)`; opaque cursor включает обе величины и hash фильтров. Cursor нельзя переносить между диапазонами/viewport/domains. Как и вся observation-time история, поздняя вставка события до уже прочитанной страницы требует обновления диапазона.

State/chunk возвращают `items`, `from`, `to`, `truncated`, `limits`, `policies`. Observation сохраняет provenance, data, confidence, observed/fetched time и evidence_state. Correlation item содержит состояние и snapshot evidence, доступные на выбранное время. Coverage buckets включают количество, домены и пример геолокации для фокусировки; это bounded summary, при усечении UI сообщает Partial coverage.

## Storage и queries

Миграции **005_world_replay.sql** и **006_replay_weather_interval.sql** выполняются существующим migration runner один раз в транзакции; повторный запуск безопасен. Существующие observations/objects/links не переписываются.

- `intelligence_timeline_time(timeline_at,id) WHERE lat IS NOT NULL`: глобальный temporal rail и выборки по времени. Добавлен после EXPLAIN старого запроса (Seq Scan + Sort); per-object indexes не обслуживали глобальный порядок.
- `intelligence_correlation_versions`: изменившийся результат правила и его evidence, с `recorded_at`; индексы `(correlation_id,recorded_at DESC,id DESC)` и `(recorded_at,id)`.
- `intelligence_replay_weather_end(valid_to,timeline_at)`: partial index для длительных погодных интервалов. Добавлен после EXPLAIN ветви valid_to; запросы без weather вообще не включают эту ветвь.
- Используются существующие native point/GiST, object/time, retention и correlation lifecycle indexes. PostGIS и вторая БД не нужны.

Correlation versions создаются транзакционно при изменении результата/evidence, expiry и dismiss. Одинаковый poll не создаёт версию. Состояние восстанавливается из lifecycle; сохранённый expires_at также завершает ACTIVE. Старые перезаписанные evidence восстановить нельзя: migration сохраняет только известную последнюю версию, раньше неё показывается отсутствие evidence/location. Snapshot history очищается bounded batches согласно event retention. Это версии отдельных correlations, не snapshots мира.

Static reference locations начинают попадать в историю при последующем on-demand registration или штатной bounded ingestion. Прошлые координаты не backfill-ятся как наблюдённые.

## Ограничения нагрузки

- Query range ≤31 день; chunk ≤6 часов; UI загружает часовые chunks.
- State ≤2000 результатов, chunk ≤10000 (UI просит 5000), events page ≤200.
- Observation candidate cap 10000, coverage cap 20000; запросы имеют timeout 4 секунды, согласованный read-only REPEATABLE READ snapshot.
- Передача observation JSON из PostgreSQL ограничена 8 MiB; correlation versions — 4 MiB; итоговый chunk — 8 MiB. При усечении `truncated=true`. Слишком большая events page возвращает 413 с просьбой уменьшить limit.
- Correlations: до 200 кандидатов, 1000 версий и 2000 lifecycle entries на запрос; coverage до 2000 version markers. При превышении есть явный признак частичного покрытия.
- Coverage cache 15 секунд / максимум 16 ключей. Frontend debounce 300–350 мс, cache до четырёх часовых chunks с TTL 60 секунд. Нет HTTP на animation frame; перемещение внутри chunk пересчитывает интервалы локально раз в секунду.
- На карте ≤2000 GeoJSON points, event rail ≤96 DOM markers, selector показывает первые 200 сигналов. Для подробного просмотра нужно сузить viewport/domains. Рядом с dateline SQL spatial prefilter уступает bounded temporal query с последующей точной фильтрацией.

## Расширение

Для нового домена добавить соответствие сохранённого event_type, visibility window и temporal semantics в `timeline-policy.js` / CASE фильтр `timeline.js`, затем frontend domain/color. Источник должен сначала писать timestamped observation с provenance через существующий HistoryService. Нельзя синтезировать историю из текущего catalog или использовать replay как источник factual relations.

## Модули

Backend: `timeline.js`, `timeline-policy.js`, `correlation-history.js`, migrations 005/006; небольшая интеграция в routes/history/correlations.

Frontend: `WorldReplayProvider`, `GlobalTimeline`, `useReplayMap`, `lib/replay.ts`; интеграция в page, OsirisMap, ObjectHistory, EntityGraphPanel, KeyboardShortcuts и investigation-map. Существующий renderer Graph и live feeds сохранены.

## Проверки

Новые PostgreSQL tests находятся в `intel/ontology/test/timeline.test.js`, frontend helpers — `src/lib/replay.test.ts`. CI автоматически подхватывает их через прежние `npm test`: Windows/Ubuntu frontend и PostgreSQL 16 backend. Тесты PG требуют настоящую БД и не имеют режима silent skip. Результаты финального запуска и smoke зафиксированы в `docs/Workflow/Log.md`.

Локально 21.09.2026: frontend 868 passed / 20 прежних skipped / 0 failed, PostgreSQL backend 71/71 без skipped. TypeScript, production build и lint новых/небольших изменённых модулей проходят. Старые page/OsirisMap сохраняют исходные 75/119 lint errors (BUG-004), новых ошибок в них нет.

Performance smoke на реальных ~2700 observations: state 93 мс / 356 items, viewport Aircraft 22 мс / 1 item, chunk 6h 323 мс / 1573 items / 2.94 MB, coverage после стабилизации стека 138 мс, cached 9–12 мс. Во время рестартов наблюдался временный 502 и первый ответ 5.1 с; последующие HTTP smoke успешны. Это разовые локальные измерения, не нагрузочный benchmark. EXPLAIN: широкий 6h запрос на небольшой базе выполнялся за 33 мс (planner выбрал Seq Scan); selective time/viewport использует intelligence_timeline_time + GiST. Запросы индексируемы, но выбор PostgreSQL на малой базе не принудительно переопределяется.

Browser smoke: historical Aircraft/Fire/USGS Earthquake; Evidence и History jump; ACTIVE в 12:59 → EXPIRED в 13:07 для реальной fire/weather correlation; Play/Pause 60× и шаг клавиатурой; Return to Live с нулём historical points и сохранёнными layer preferences/context. История Vessel/Satellite и отрицательные/пограничные temporal случаи проверены PostgreSQL tests. Production fixtures не добавлялись.

Известные пределы V1: неполное on-demand покрытие, отсутствие старых correlation evidence до внедрения версий, текущие имена/ontology graph, bounded partial results, отсутствие интерполяции и бивременного аудита. Basemap и внешний OpenSanctions имеют прежние ограничения из BugLog.
