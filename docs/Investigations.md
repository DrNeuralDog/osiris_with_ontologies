# Расследования и подборки объектов (Stage 4)

Case — сохранённый аналитический контекст: вопрос, связанные материалы и заметки.
Принадлежность одному Case **не создаёт фактическую связь** в онтологии.
Рабочее пространство использует действующие PostgreSQL, MapLibre, EntityGraphPanel,
observations, correlation versions и World Replay. Второго ingestion нет.

## Запуск и язык

После обновления: `docker compose up -d --build`. Затем обычный
`docker compose up -d`; порт 3000, существующий volume и BAT launcher не меняются.
Миграция `008_investigations.sql` выполняется существующим migration runner один раз
под advisory lock, без перезаписи ontology/history.

RU / EN находится в Intelligence Center. Язык хранится в браузере (`osiris.locale`),
по умолчанию учитывается язык браузера. Переключение не пересоздаёт карту и не
сбрасывает слои/Replay/Case. `html.lang` обновляется. Переводится интерфейс, включая
подписи действий, слои, панели, подсказки и статические метки map popups.
Новости, имена объектов, пользовательские заметки, raw metadata, исходные сообщения
ошибок поставщиков и provenance не переводятся. Технические идентификаторы API/DSL
остаются стабильными. Названия на базовой карте зависят от картографического источника.
Каталог переводов находится в `src/lib/i18n`; неизвестная строка остаётся оригинальной.

## Пользовательский сценарий

1. В Intelligence Center открыть **Расследования**, указать вопрос/название.
2. На объекте карты, в графе, истории, корреляции, World Data, Replay или Air Threat
   нажать **В расследование**. Выбрать существующий Case либо создать новый.
3. Карточка активного Case показывает реальные counters и переходы в рабочую область.
4. Вкладки: Обзор, Карта, Граф, Хронология, Свидетельства, Заметки.
5. В Объектах и подборках задать фильтры, выполнить запрос, сохранить Dynamic/Snapshot,
   прикрепить подборку либо явно закрепить выбранные/видимые результаты.

**Обзор:** метаданные, метки, bbox, диапазон UTC, настоящие counters, прикреплённые
подборки с текущим количеством совпадений, действия архивирования/восстановления,
JSON/GeoJSON, журнал действий. Закрытие контекста не архивирует Case.

**Карта:** отдельный case-only вид того же MapLibre engine; без live feeds.
Точки из `snapshot_at_add` отмечены как снимки при добавлении, не как текущие позиции.
Есть фильтры типа/времени, focus all, переход к объекту и World Replay.
Материалы без координат остаются в списке с указанием их количества.

**Граф:** до 100 закреплённых canonical objects, существующие связи между ними.
Опционально один соседний уровень: максимум 200 узлов и 300 рёбер. Используется
EntityGraphPanel с прежними evidence, пунктиром inferred и recursive expansion.
Дальнейшее интерактивное раскрытие использует прежние лимиты ontology API.

**Хронология:** фактические observations закреплённых объектов/выбранные observations,
correlation lifecycle и сохранённые derived analyses объединены по времени.
Изменения членства и заметок показываются отдельно в журнале действий.
Переход в World Replay сохраняет активный Case и фокусирует точку, если она известна.
Текущие свойства объекта не превращаются в историческую телеметрию.

**Свидетельства:** исходный provider, record/source ID, URL, observed/fetched timestamp,
evidence state, source confidence (либо «не указано»), extraction method.
Снимок и время добавления отделены от времени исходного события.

**Заметки:** обычный текст до 10 000 символов. HTML не выполняется; заметку можно
привязать к Case item. Сохранение и правки отражаются в журнале.

## Таблицы и references

| Таблица | Назначение |
|---|---|
| `investigation_cases` | UUID, title, description, OPEN/ARCHIVED, tags, AOI/time range, timestamps |
| `investigation_case_items` | Строго typed reference, optional FK, immutable snapshot, pin, added_at |
| `investigation_case_notes` | Текст заметки, Case FK, optional item FK, timestamps |
| `investigation_case_activity` | Последние 1000 действий аналитика в Case |
| `investigation_object_sets` | Название, DYNAMIC/SNAPSHOT, проверенный query DSL |
| `investigation_set_members` | Только типы/IDs зафиксированной выборки |
| `investigation_case_object_sets` | Связь Case с сохранённой подборкой |
| `investigation_analyses` | Versioned snapshot выбранного кластера/акустического сценария |

Тип reference: `object`, `observation`, `correlation`, `analysis`. Fire, earthquake,
weather, aircraft/vessel/satellite, infrastructure и conflict не копируются: используются
существующие canonical objects/observations. Повторное добавление идемпотентно.
Aliases учитываются при повторном добавлении и построении графа.

Snapshot формирует сервер из canonical данных; клиент не может подменить evidence.
Снимок ограничен 64 KiB, глубиной 8, длиной текста 4000 и размером вложенных коллекций.
Это bounded summary, а не полный архив raw source. Исходные IDs остаются references.
Обычная retention может удалить observation: FK станет NULL, reference ID и snapshot
останутся читаемыми. Snapshot не продлевает глобальную telemetry retention.
Удаление membership не удаляет источник, observation, correlation или ontology object.

Кластеры пересчитываются действующим AirThreatService по переданным AOI/времени,
акустический сценарий — по явным параметрам пользователя. Сохраняются модель/версия,
source IDs, допущения и DERIVED classification. Произвольный фактический snapshot API
не принимает. Correlation из Replay сохраняется по version/lifecycle на указанное время.

## Object Set DSL

Нет raw SQL. Пример:

```json
{
  "kind": "observations",
  "last_hours": 6,
  "bbox": [29, 49, 32, 52],
  "filters": [{"field":"subtype","op":"in","value":["CONFLICT_REPORT","OFFICIAL_ALERT","HEARD_EXPLOSION"]}],
  "any": [],
  "limit": 50
}
```

`kind`: `objects`, `observations`, `correlations`.
`filters` соединяются AND, `any` — одна ограниченная OR-группа, соединённая AND
с основными условиями. Максимум 16 условий, из них до 6 в OR, до 30 значений `in`.

Поля: `type`, `subtype` (event_type для observations), `name`, `provider`,
`evidence_state`, `freshness`, `object_id`, `status`, `correlation_type` и whitelist
`properties.military`, `magnitude`, `frp`, `country`, `category`, `source_class`,
`location_precision`. Операции: `eq`, `in`, числовой `range`, `exists` с boolean.
Типы значений проверяются. Для наблюдений evidence state использует исходные
нижнерегистровые значения (`observed`, `reported`, `derived`, `imported`, `inferred`).

Диапазон: `from`/`to` в ISO UTC либо относительный `last_hours` (до 744).
Без диапазона observations/correlations ограничиваются последними 24 часами.
Для objects без времени допустим bounded просмотр сохранённых идентичностей.
Aircraft «наблюдался за час» означает фактические observations, а не OBJECT_CREATED.
Freshness использует существующие domain policies относительно времени вычисления.

Примеры:

- Самолёты: kind objects, type aircraft, last_hours 1, bbox выбранной области.
- Пожары: kind observations, subtype FIRE, last_hours 24.
- Конфликты: пример выше.
- Активные корреляции: kind correlations, status ACTIVE, last_hours 24.

**DYNAMIC:** запрос вычисляется заново. Совпадения не закрепляются автоматически.
**SNAPSHOT:** сохраняются до 100 reference IDs при создании; если найдено больше,
возвращается `truncated`. После retention отсутствующий member остаётся в списке
как unavailable. Это не snapshot всего мира и не отдельная factual observation.

## API

Все публичные маршруты под `/api/investigations`; backend — `/investigations`.

| Метод / путь | Назначение |
|---|---|
| GET/POST `cases` | Поиск / создание |
| GET/PATCH `cases/:id` | Метаданные, counters, attached sets / правка |
| GET/POST `cases/:id/items` | Страница материалов / добавить reference |
| POST `cases/:id/items/batch` | Атомарно до 20 references |
| PATCH/DELETE `cases/:id/items/:item` | Pin / удалить membership |
| GET/POST `cases/:id/notes` | Заметки / создать |
| PATCH `cases/:id/notes/:note` | Изменить текст |
| GET `cases/:id/activity` | Журнал аналитика |
| GET `cases/:id/timeline` | Общая временная выборка |
| GET `cases/:id/graph?expand=true` | Граф с optional one-hop |
| POST `cases/:id/sets` | Прикрепить `{set_id}` |
| DELETE `cases/:id/sets/:set` | Отсоединить |
| GET `cases/:id/set-counts` | Текущие совпадения прикреплённых подборок |
| GET `cases/:id/export?format=json` | JSON или geojson |
| GET/POST `sets` | Список / сохранить `{title,mode,query}` |
| GET `sets/:id` | Определение |
| GET `sets/:id/results` | Вычислить / прочитать snapshot references |
| POST `sets/evaluate` | Предпросмотр DSL |
| POST `analyses` | Server-derived cluster/acoustic reference |

Case search: `status`, `q`, `tag`, `limit`, `cursor`. Item search дополнительно `type`,
`from`, `to`. Timeline использует составной `(timestamp,event_key)` cursor, без потери
микросекунд; query cursors привязаны к фильтрам и фиксируют относительное окно.
Dynamic set не обещает snapshot isolation между запросами: текущие факты могут
измениться; для фиксации аналитического состава используйте SNAPSHOT.

## Ограничения и безопасность

- 500 материалов, 200 заметок, 30 attached sets на Case; 100 строк на страницу.
- 31 день на временной запрос, bbox до 60° по каждой оси (без antimeridian crossing).
- SQL timeout 4 секунды для DSL/Graph/Timeline, до 10 секунд для простых чтений; ответы 2 MiB. JSON/GeoJSON Case export — до 32 MiB.
- Count для dynamic set ограничен 500: `truncated` означает «500+».
- Next proxy: allowlist маршрутов, UUID, same-origin mutations, JSON до 64 KiB,
  rate limits 120 чтений / 60 изменений за минуту на IP. Batch — до 20 ссылок.
- SQL только parameterized; никакого выбора таблицы или URL fetch из клиентского ввода.
- API keys/credentials не читаются этим сервисом; чувствительные ключи metadata
  исключены из snapshot. Публичные источники не переопределяют действия аналитика.
- Private single-deployment модель. RBAC, notifications, actions, AI и full import
  не добавлены. Не выставляйте частный workspace в интернет без внешней защиты.
- GeoJSON включает только географические материалы; JSON включает также заметки,
  references, snapshots, определения и состав snapshot sets.

## Проверки

`npm test`, `npm run build`, `npx tsc --noEmit`;
backend: `docker compose exec -T osiris-intel npm test`.
PostgreSQL tests создают изолированную временную schema и требуют живую БД.
Текущий CI запускает frontend на Ubuntu/Windows и backend с PostgreSQL 16.
Live данные не подменяются fixtures для браузерного smoke.

В Case Map при Replay moving identities остаются в списке, но координаты берутся
только из доступных наблюдений текущего загруженного viewport World Replay. Если
таких наблюдений нет, точка скрыта, а материал и сохранённый Evidence остаются доступны.
Статические справочные объекты отмечаются как контекст; снимок при добавлении не
используется как выдуманная историческая позиция.


Проверка 2026-09-21: frontend 929 passed (20 прежних opt-in skipped), backend
115 passed / 0 skipped на PostgreSQL 16; TypeScript, production build и lint новой
логики успешны. Remote GitHub jobs не запускались без push. Case endpoints на
реальных сохранённых материалах: 14–20 мс, запросы подборок 4–40 мс; это локальный
smoke, не нагрузочный benchmark. Старый lint debt и transient cold-start задержки
описаны отдельно в docs/Workflow/BugLog.md.
