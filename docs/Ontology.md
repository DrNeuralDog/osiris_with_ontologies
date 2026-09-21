# Persistent Ontology V1

OSIRIS сохраняет прежние карту, SDK и `/resolve`. Новый слой добавляет постоянные объекты, типизированные связи, происхождение данных и интерактивное расследование.

## Запуск на Windows

Нужен Docker Desktop в режиме Linux containers. WSL-команды и отдельно установленный PostgreSQL не нужны. Проверено через PowerShell, Docker Engine 20.10.17 и Compose 2.10.2.

```powershell
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://localhost:4000/health
Invoke-RestMethod http://localhost:3000/api/health
```

Открыть `http://localhost:3000`. `osiris`, `osiris-intel`, `osiris-postgres` имеют healthcheck; cache стартует после готовности приложения. PostgreSQL не публикует порт наружу, intel доступен на `127.0.0.1:4000`. Том `osiris_ontology-postgres` сохраняет данные при рестарте и пересоздании контейнеров. `docker compose down -v` удалит данные — для обычной остановки флаг `-v` не нужен.

`.env` необязателен. Compose подставляет перечисленные в `docker-compose.yml` API keys и настройки из `.env`/окружения, включая существующие ключи OpenSky, AIS, Cloudflare и scanner. Для дополнительной переменной добавьте явное отображение в `environment`. Поддерживается `OSIRIS_PORT`; пароль БД задаёт `ONTOLOGY_DB_PASSWORD`. Значение `osiris-local-dev` — только локальный development default. Изменение этой переменной не меняет пароль уже созданной базы: его нужно согласованно изменить в PostgreSQL. Реальные секреты в Git не добавлять.

Старая обязательная внешняя сеть `umami_default` исключена из основного compose, чтобы чистый запуск не требовал стороннего сервиса. При собственной установке Umami сеть можно подключить отдельным compose override; аналитика не является зависимостью ontology.

Без Docker для Node-разработки: PostgreSQL должен быть доступен через `DATABASE_URL` либо стандартные `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`; `npm ci` и `npm start` выполняются в `intel`, затем `npm run dev` в корне. `INTEL_URL` используется только на сервере Next.js.

## Интерфейс

1. Выберите самолёт, судно, IP-индикатор или компанию/владельца инфраструктуры на карте. В карточке нажмите **Explore relationships**.
2. Для страны нажмите правой кнопкой на карту, затем **Explore country relationships** в досье. Если источник вернул главу государства/правительства, рядом доступно **Explore person relationships**.
3. Кнопка **ONTOLOGY** открывает поиск: лупа ищет сохранённые объекты, **Resolve source** обращается к источнику. Например, тип `company`, идентификатор `Q312`.
4. Нажатие на узел показывает свойства и раскрывает следующий уровень. Узлы имеют цвета типов, стрелки показывают направление. Пунктиром отмечены предположения. Нажатие на связь открывает её provenance, confidence и период действия.
5. **Make root** начинает просмотр с выбранного узла; **Reset** возвращает исходный root и ближайшие связи; **Refocus** вписывает граф в экран. **Close**/Escape закрывает панель. Список Loaded objects позволяет выбирать узлы клавиатурой.

Поиск по имени возвращает **кандидатов**, соединённых `ASSOCIATED_WITH` с `candidate: true`. Это не подтверждённое совпадение личности. Нажмите правильный объект Wikidata, чтобы раскрыть его фактические утверждения источника. Если устойчивого идентификатора нет, исходная запись сохраняется отдельно как `unresolved`; одинаковые имена не являются основанием для слияния.

## Архитектура

```text
Map / EntityGraphPanel
    → Next /api/ontology/* (валидация путей, origin, лимиты, серверный proxy)
    → osiris-intel /ontology/*
        sources.js → существующие resolvers.js + Wikidata statements
        model.js → normalization и валидация
        store.js → PostgreSQL, транзакции, миграции, обход графа
```

Существующие resolver-функции вынесены из `server.js` в `intel/resolvers.js`. Сохранены Wikidata SPARQL, OpenSanctions, aircraft/vessel/company/person/country, ip-api и RIPE. `/resolve` сохраняет прежние `nodes`, `links`, `entity`, добавляет `canonical_id` и записывает результат через адаптер. Сетевые вызовы выполняются до транзакций БД. Новый QID-путь читает идентификаторы и statements Wikidata, qualifiers и references; факт определяется источником, без LLM.

`/api/entity/expand` остаётся совместимым proxy к `/resolve`. Graph Explorer использует новый API с UUID. Постоянные UUID и старые строковые IDs legacy-графа намеренно различаются.

## Таблицы

| Таблица | Назначение |
|---|---|
| `ontology_objects` | UUID, type, canonical_name, properties JSONB, created_at/updated_at |
| `ontology_identifiers` | Уникальные namespace/value, ссылка на canonical object; API возвращает их как external_ids |
| `ontology_links` | UUID, source/target, link_type, properties JSONB, confidence, valid_from/valid_to, timestamps |
| `ontology_provenance` | Объект **или** связь, provider, source_id, URL, observed_at/fetched_at, confidence, kind, metadata |
| `ontology_aliases` | Старый UUID → canonical UUID после объединения |
| `ontology_object_types`, `ontology_link_types` | Реестры типов с внешними ключами |
| `ontology_migrations` | Применённые миграции и время применения |

Объекты: Aircraft, Vessel, Company, Person, Country, IP, Location, Organization, Event; также зарегистрированы Observation, Infrastructure, Satellite, Domain, Airport и Port. Наличие типа не означает наличие отдельного внешнего resolver для него.

Связи: OPERATED_BY, OWNED_BY, REGISTERED_IN, HEADQUARTERED_IN, CEO, PARENT_ORG, EMPLOYED_BY, NATIONALITY, MEMBER_OF, LOCATED_IN, OBSERVED_AT, ASSOCIATED_WITH, SANCTIONS_MATCH. Отдельные связи с разными периодами действия сохраняются отдельно.

## Identity и provenance

- ICAO24 нормализуется в нижний регистр; registration — в верхний без дефисов/пробелов; QID, IMO, MMSI, ASN, IPv4/IPv6, ISO3166 имеют отдельные правила.
- Уникальный индекс идентификаторов и транзакционная advisory lock предотвращают дубли при параллельном импорте. Если новый набор ID связывает ранее раздельные записи одного типа, связи и evidence переносятся, старые UUID остаются рабочими через aliases. Противоречащие типы дают `409`, без частичного импорта.
- Имя само по себе не создаёт глобальный identity key. В legacy-источниках без устойчивого ID остаётся ограниченная источником запись; её нельзя бездоказательно объединить с одноимённой сущностью из другого источника.
- `reported` означает утверждение источника, `observed` — наблюдение, `derived` — детерминированный вывод, `inferred` — предположение. Совпадения санкционного списка по имени и оператор по префиксу позывного имеют `inferred` и явное предупреждение.
- `confidence: null` означает, что источник не предоставил оценку. Число 0.5 у эвристики — техническая оценка адаптера, не статистически откалиброванная вероятность.
- Свойства в объекте отражают последний импорт; provenance сохраняет снимок свойств каждой записи источника. Повтор одной и той же evidence обновляет fetched_at, а не размножает записи. API показывает последние 50 evidence для объекта/связи; более старые остаются в БД.
- Wikidata P159 отображается как HEADQUARTERED_IN. P17 означает связь со страной, поэтому отображается как ASSOCIATED_WITH, без утверждения о юридической регистрации.

## HTTP API

На frontend prefix `/api/ontology`, на intel — `/ontology`.

| Метод / путь | Результат |
|---|---|
| GET `/types` | Типы объектов и связей |
| GET `/objects?q=Apple&type=company&limit=30` | Поиск сохранённых объектов |
| GET `/objects?namespace=icao24&value=abc123` | Поиск по нормализованному ID |
| GET `/objects/:uuid` | Свойства, идентификаторы, provenance |
| GET `/objects/:uuid/graph?depth=2&direction=both` | Ограниченный обход сохранённого графа |
| GET `/objects/:uuid/relationships?direction=in` | Ближайшие, в том числе обратные связи |
| POST `/objects/:uuid/expand` | Обогащение одного объекта и ближайший сохранённый граф |
| POST `/resolve` | Выбор root по типу/ID, обогащение, граф |
| POST `/ingest` | Только intel: импорт объектов и связей одной транзакцией |
| POST `/observations` | Только intel: наблюдение объекта с временем и координатами |

`graph` не вызывает внешние источники рекурсивно. Глубина 0–4, max_nodes 1–250, max_edges 1–500; значения по умолчанию 1/100/250. Циклы и повторно загруженные nodes/links не размножаются. `truncated` предупреждает о достижении лимита. UI также ограничен 250/500 на всю текущую сессию расследования. Сервер ограничивает параллельное обогащение, имеет таймауты, rate limit и короткое окно повторного раскрытия.

Пример:

```powershell
$body = @{type='company'; id='Q312'} | ConvertTo-Json
$g = Invoke-RestMethod http://localhost:3000/api/ontology/resolve -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod "http://localhost:3000/api/ontology/objects/$($g.root_id)/graph?depth=2&max_nodes=100"
```

Импорт через локальный intel: `objects` — массив `{type, canonical_name, external_ids:[{namespace,value}], properties, provenance:[...]}`; `links` — массив `{source:0,target:1,link_type,properties,confidence,valid_from,valid_to,provenance:[...]}`. `source`/`target` — индексы в переданном массиве. Ответ содержит `object_ids`. Ошибка откатывает весь импорт.

Observation принимает `{object_id,lat,lon,observed_at,provenance:{provider,source_id,kind,...}}`. В одной транзакции создаёт Object → OBSERVED_AT → Observation → LOCATED_IN → Location. Повтор той же записи не создаёт дубль. Без времени наблюдения запрос отклоняется: время клика на карте не выдаётся за время измерения. Автоматический поток телеметрии в V1 не включён.

Коды ошибок: 400 malformed input, 404 отсутствующий объект, 409 конфликт типов для одного ID, 413 слишком большой запрос, 429 ограничение нагрузки, 502 недоступный intel на frontend, 503 database health. Внешний сбой обогащения возвращает сохранённые сведения и `warnings`, а не стирает граф.

## Расширение

1. Object Type: добавить имя в `model.js` OBJECT_TYPES, при необходимости правила ID, цвет в `src/lib/ontology.ts`. Реестр синхронизируется при старте. Изменения таблиц оформлять новым SQL-файлом в `migrations/`, уже применённые файлы не переписывать.
2. Link Type: добавить имя в LINK_TYPES, настроить явное отображение свойства источника, provenance и тесты. Не заменять неизвестную семантику похожим фактом: использовать ASSOCIATED_WITH и metadata исходного отношения.
3. Resolver: модуль возвращает нормализованные objects/links, устойчивые IDs и provenance. Использовать `fetch-source.js`: разрешённые hosts, проверка каждого redirect, максимум пять переходов; задать timeout и лимиты. Вызвать `store.ingest` после сети. Никогда не строить identity только по подписи. Резервный поиск страны проверяет P297 (ISO 3166), прежде чем принять QID.
4. Map source: адаптировать в `mapInvestigationSeed`, передать исходные IDs в GeoJSON properties, добавить явную кнопку через существующий обработчик. SDK Polybolos не изменён; его `source.originalId` можно передать как source-specific ID при подключении следующего источника.

SQL параметризован. Browser не получает пароли БД и секреты поставщиков. Proxy не принимает произвольный URL и не публикует общий `/ingest`. Это локальная V1: пользовательские роли, ACL и совместная работа требуют отдельного слоя аутентификации перед публикацией сервиса.

## Проверки

```powershell
npm test
npm run build
docker compose exec -T osiris-intel npm test
node --test intel/ontology/test/model.test.js
./tools/ontology-smoke.ps1 -Restart
```

Backend suite использует настоящий PostgreSQL и отдельную случайную схему `ontology_test_*`; удаляет только собственную схему. Рабочие ontology-объекты не очищаются. Проверяются persistence, миграции, параллельная дедупликация, объединение и aliases, обратный обход, циклы, лимиты, интервалы, provenance, Observation, транзакционный rollback, malformed input, missing objects и `/resolve`. Frontend unit tests проверяют объединение графов, identity адаптера карты, allowlist proxy и Origin в Docker.

Известный Windows baseline: `src/lib/geo.test.ts > formatting > switches units at sensible thresholds`, `4 200 km` против `4,200 km`. Он не скрыт и не исправлялся в ontology-задаче. Итог фактических проверок — в `docs/Workflow/Log.md`.

Ограничения: внешние источники могут быть недоступны/ограничивать запросы; в таком случае данные уже сохранённого графа доступны, обогащение неполное. Автоматическое разрешение неоднозначных имён, полная таксономия Wikidata, история пересмотра фактов и автоматическая синхронизация всех потоков OSIRIS не включены. Связи не удаляются только потому, что исчезли из очередного ответа источника.

21.09.2026: фактическая загрузка OpenSanctions CSV обрывается (`UND_ERR_SOCKET`; обычный Windows curl также получил лишь 10 136 из 7 556 118 байт за 35 секунд). Индекс не загрузился. UI явно предупреждает об этом, отсутствие совпадений не означает отсутствие санкций. Перенаправление на датированный файл поддержано с allowlist. Загрузчик и сохранение старого индекса проверены на CSV fixture; повтор неуспешной загрузки выполняется каждые 30 минут, обновление успешного индекса — через 24 часа. Внешнюю доступность нельзя считать подтверждённой тестом fixture.

## Изменённые файлы V1

- `docker-compose.yml`, `intel/Dockerfile`, `intel/.dockerignore`, `intel/package.json`, `intel/package-lock.json`, `package.json`: контейнеры, PostgreSQL, зависимости, команды тестирования.
- `intel/server.js`, `intel/resolvers.js`: существующие resolvers выделены в модуль, сохранён `/resolve`, добавлен постоянный слой.
- `intel/ontology/{model,store,sources,fetch-source,routes,observations}.js`: модели, persistence, нормализация, источники, API, наблюдения.
- `intel/ontology/migrations/{001_initial,002_country_semantics}.sql`: начальная схема и корректировка семантики P17 с сохранением provenance.
- `intel/ontology/test/{model,persistence}.test.js`: 21 backend-тест.
- `src/lib/ontology.ts`, `src/lib/ontology.test.ts`: типы, адаптер карты, объединение графа и тесты.
- `src/app/api/ontology/[...path]/route.ts`, `src/app/api/ontology/route.test.ts`: серверный proxy и тесты; `src/app/api/entity/expand/route.ts`: совместимый старый proxy.
- `src/components/EntityGraphPanel.tsx`, `src/components/OsirisMap.tsx`, `src/app/page.tsx`, `src/app/api/region-dossier/route.ts`: граф, действия карты и сохранение QID досье.
- `tools/ontology-smoke.ps1`, `README.md`, `docs/Ontology.md`, `docs/Workflow/{Log,BugLog}.md`: воспроизводимая проверка и документация.

Ранее изменённые `intel/node_modules`, а также пользовательские `off`, `START_OSIRIS_FIXED.bat`, `sprites/` не редактировались в рамках задачи. Коммиты и push не выполнялись.

Технические источники, проверено 21.09.2026: [PostgreSQL advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html), [параметризованные запросы node-postgres](https://node-postgres.com/features/queries), [свойства авиации Wikidata](https://www.wikidata.org/wiki/Wikidata:WikiProject_Aviation/Properties).
