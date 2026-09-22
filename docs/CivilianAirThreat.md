# Civilian Air Threat Awareness — Stage 3C.1

Гражданский контекст по сохранённым сообщениям, а не радар и не система оповещения. Официальные гражданские предупреждения имеют приоритет. Отсутствие сообщений не означает отсутствие угрозы.

## Использование

В Intelligence Center нажмите **CIVILIAN AIR THREAT**. Найдите город через существующий поиск карты, задайте небольшой viewport или прямоугольник `west,south,east,north`. Для официального административного статуса выберите точный ID области/района из каталога полученных предупреждений; можно ввести документированный provider ID вручную. Имя AOI служит подписью, не identity. Core не содержит условий по стране.

Панель показывает время анализа, официальные записи, количество сообщений, классы источников, точность географии, покрытие, кластеры и evidence. Переключатели категорий управляют WebGL-слоем. Выбранное сообщение открывает существующие Graph / History / Evidence / Related objects. **Jump to global timeline** использует общий World Replay. Закрытие панели убирает её overlays, сохраняя AOI.

## Архитектура и хранение

`src/lib/air-threat/providers.ts` → существующий `/api/world/conflicts` → существующий worker `world-conflicts` → ontology + `intelligence_observations` → `intel/intelligence/air-service.js` → AirThreatProvider / Panel / Map. Второй ingestion pipeline не создаётся. Source Health получает capabilities тем же worker.

Новые observation types: `OFFICIAL_ALERT`, `HEARD_EXPLOSION`; прежний `CONFLICT_REPORT` сохранён. Identity — namespace провайдера и его record ID. Ручная транскрипция публичного сообщения использует URL + record ID, отмечается `client_supplied`, не становится OFFICIAL. URL сохраняется как evidence и не загружается сервером.

Миграция `007_civilian_awareness.sql` добавляет:

- `intelligence_sources.credential_state`, `coverage_metadata` — доступ отдельно от сетевого здоровья;
- `intelligence_official_alert_states` — интервалы подтверждений, ссылки на исходные observations, исходное время и административные IDs;
- индексы времени, administrative ID (GIN) и выборки air observations; прежний spatial GiST используется для AOI.

Повторная миграция безопасна. Старая ontology/history сохраняется. Retention событий остаётся `HISTORY_RETENTION_DAYS` (по умолчанию 90 дней), telemetry не изменяется. Очистка официальных подтверждений ограничена размером batch и тем же сроком. Кластеры и envelopes вычисляются из сохранённых сообщений, полные снимки мира не записываются.

## Провайдеры и доступ

Документация проверена 21.09.2026:

| Provider | Реализация / ограничения |
| --- | --- |
| alerts.in.ua | Optional адаптер официальных сообщений через волонтёрский relay. Bearer `ALERTS_IN_UA_TOKEN` только server-side. Active endpoint и документированная regional history, Last-Modified / If-Modified-Since / 304. [Документация](https://devs.alerts.in.ua/) |
| UkraineAlarm | Optional interface, KEY_REQUIRED без ключа. Даже с `UKRAINE_ALARM_API_KEY` требуется выданный провайдером API contract/access; непроверенный endpoint не вызывается. [Запрос доступа](https://api.ukrainealarm.com/) |
| Israel Home Front Command | DOCUMENTED_API_REQUIRED. Проверенного разрешённого developer interface нет; hidden endpoints и bypass не используются. [Официальный сайт](https://www.oref.org.il/eng) |
| GDELT / War-Tracker | Существующие global Stage 3 feeds. War-Tracker пробует документированный civil-alert query без обязательного локального ключа; отказ провайдера означает ACCESS_REQUIRED. Это STRUCTURED_OSINT, не гражданская служба оповещения. Покрытие РФ и других стран зависит от реальных сообщений. |
| Detector AERO | Только future capability: документированный API или письменное разрешение. Не подключён, scraping отсутствует. |
| Public reports | Ручная транскрипция конкретного публичного сообщения с URL, ID, временем и географической точностью. Existing Live Alerts автоматически передаёт явно классифицированные гражданские предупреждения и сообщения о звуке; второй scraper отсутствует. |

alerts.in.ua: cache/coalescing 120 секунд, максимум active + одна regional-history загрузка за цикл, бюджет 1500 циклов/сутки. Это ниже опубликованных лимитов 8–10 запросов/минуту (жёсткий 12). До 32 недавно встреченных регионов проверяются по очереди. Отбой приходит только из явного `finished_at`. Исчезновение из active list и IoT `N` не преобразуются в отбой. После рестарта список regional-history обхода восстанавливается из полученных active alerts; до повторного подтверждения возможен UNKNOWN. Учитывайте условия supplementary use и attribution relay; это не замена официальной системе оповещения.

Для нового провайдера добавьте `OfficialAlertProvider` с документацией, coverage, credential state, cadence, mapper и fetch. Подключайте fetch к **существующему** world-conflicts feed, whitelist backend provider и trusted classification. Добавьте fixtures, source health и identity tests. UI по стране изменять не требуется.

## Taxonomy, evidence и география

Единый `intel/intelligence/air-policy.json` содержит AIR_RAID_ALERT, PRE_ALERT, ALL_CLEAR, DRONE_THREAT/REPORT/ATTACK, ROCKET_ALERT, MISSILE_THREAT/REPORT/LAUNCH, BALLISTIC_MISSILE_THREAT, CRUISE_MISSILE_THREAT, GUIDED_BOMB_THREAT, AIR_DEFENSE_ACTIVITY, INTERCEPTION_REPORT, EXPLOSION_REPORT, AIRSTRIKE, MILITARY_STRIKE, HEARD_EXPLOSION, HEARD_SOUND и CONFLICT_EVENT.

Mapper сохраняет `provider_raw_type` и raw metadata. Подтипы alerts.in.ua сохраняются в `threat_types`; неподдержанные значения остаются raw. Активность авиации не превращается в ракетную угрозу. Source class OFFICIAL / STRUCTURED_OSINT / PUBLIC_REPORT отличается от evidence state REPORTED / DERIVED: официальное сообщение тоже не является локальным измерением OSIRIS. Числовая confidence без значения провайдера остаётся неизвестной.

Точность: EXACT_SOURCE_COORDINATE / LOCALITY / DISTRICT / REGION / APPROXIMATE / UNKNOWN. Координата провайдера не считается независимо проверенной. District/region centroid явно representative. Если административный источник не даёт координаты/полигона, запись доступна по admin ID в панели; координаты не геокодируются по догадке. Границы административных областей в этой версии не поставляются. Bbox сам по себе не доказывает покрытие официальной системой.

## Heatmap и clustering

Возраст относительно выбранного времени: <15 мин RECENT, 15–30 FRESH, 30–60 AGING, 1–6 часов STALE. Пороги едины в policy. Цвет означает класс источника, opacity — возраст, не вероятность.

Heatmap означает концентрацию сообщений. Вес — линейное уменьшение по возрасту, коэффициент точности и ограниченный вклад числа source families; известные перепечатки по lineage/URL учитываются слабее. Это **не** вероятность присутствия летательного аппарата.

Кластеры: совместимое семейство AIR / CONFLICT / ACOUSTIC, окно 20 минут, все пары в пределах 25 км (acoustic 10 км) либо общий provider administrative ID. Один provider record с повторными версиями считается одним текущим сигналом данного типа. Cross-provider записи не сливаются. Общий URL/original-source ID даёт один lineage signal; source families не называются независимыми без доказательств. Неизвестная независимость явно UNKNOWN.

Activity envelope — прямоугольник вокруг reported locations с грубым округлением и display padding, не измеренный периметр угрозы. Он имеет DERIVED, model version, IDs исходных observations, временное окно, правило совпадения и объяснение. Для записей без координат геометрия отсутствует. Никаких inferred weapon positions, маршрутов, целей, триангуляции или прогнозов.

## Акустика и неопределённость

`HEARD_EXPLOSION` описывает место/время **сообщения о звуке**, а не место взрыва и не его тип. Эти сообщения группируются, но никогда не становятся входной точкой обратной локализации.

Опциональный forward overlay доступен только для уже указанной источником позиции EXPLOSION_REPORT / AIRSTRIKE / MILITARY_STRIKE / INTERCEPTION_REPORT. Одной координаты недостаточно: пользователь явно задаёт **сценарные** reference SPL, reference distance и background level. Приложение не назначает их из слова «взрыв».

Модель `acoustic-sensitivity-v1`: свободное сферическое расхождение `20 log10(distance/reference)`. [OSHA Technical Manual](https://obis.osha.gov/dts/osta/otm/new_noise/) описывает такое приближение для свободного поля; оно не подтверждает дальность слышимости конкретного взрыва. Пороги 0/10/20 dB над заданным background обозначены ESTIMATED POSSIBLY / LIKELY / VERY LIKELY AUDIBLE, **scenario only**, не калиброванными вероятностями.

Существующий Stage 3B Open-Meteo используется по запросу пользователя: сохраняется один ближайший model grid observation. В Replay используются только retained weather <= выбранного времени и не старше часа, в пределах ±0.2°. Ветер задаёт явно некалиброванный sensitivity modifier до ±6 dB по направлению; это не атмосферный ray tracing. Temperature/humidity выводятся как контекст; без спектра не применяется выдуманная absorption correction. Terrain, urban reflections, land cover и background observations автоматически не доступны. Они marked UNAVAILABLE, uncertainty HIGH либо VERY_HIGH при неточной позиции. Геометрия ограничена 25 км ради отображения; за её пределами нельзя заключать «безопасно» или «не слышно».

## Replay и official lifecycle

Общий World Replay timestamp передаётся в state API. Reports, age, clusters и envelopes реконструируются относительно этого времени; сообщения из будущего исключаются. Старые observations не соединяются в физические пути. LIVE snapshot не выдаётся за исторический при переключении. До следующего throttled refresh показывается время последнего рассчитанного snapshot.

Официальный status хранится отдельно от source timestamp: подтверждение действительно максимум 6 минут после последней успешной записи worker. Повторный источник продлевает подтверждение, gap остаётся gap. ACTIVE / CLEAR восстанавливается из версии, существовавшей тогда. CLEAR — только явный отбой **совпавших записей**, не гарантия всеобщего регионального отбоя. При replay текущее здоровье провайдера явно не выдаётся за историческое покрытие. Пределы истории остаются authoritative.

## API и bounds

Публичный frontend proxy сохраняет allowlist и rate limits:

- `GET /api/intelligence/air-threat/state?bbox=...&admin=provider:id&at=ISO&limit=500`: требуется bbox или admin; at optional (NOW); последние 6 часов, AOI <=30° по каждой оси, без antimeridian crossing. Limit <=1000 observations, <=100 clusters, <=200 official state records, JSON candidate budget 4 MiB, SQL timeout 4s. Truncated явно виден. Cache 10s / 20 keys; frontend polling 20s, replay refresh не чаще 10s.
- `GET /api/intelligence/air-threat/areas`: до 200 административных identities из сохранённых official observations за 90 дней.
- `POST /api/intelligence/air-threat/acoustic`: retained `observation_id`, optional `at`, `scenario=true`, `reference_db`, `reference_m`, `background_db`; body <=2 KiB, 20 запросов/минуту, same-origin, фиксированный backend endpoint.

Public acoustic transcription использует прежний `/api/intelligence/investigate`; history/evidence — прежние ontology/intelligence APIs. Никакой arbitrary URL probe. Все SQL values parameterized, нет секретов в browser. UI не опрашивает каждый кадр, геометрия MapLibre/WebGL, список сообщений выдаётся по 30 строк.

## Запуск и проверки

Windows + Docker Desktop: `docker compose up -d --build`, затем прежний `docker compose up -d` / `START_OSIRIS_FIXED.bat`. Порт 3000, volume и схема существующей БД сохраняются. Переменные уже передаются Compose, второй DB/backend не нужен.

Frontend: `npm test`, `npx tsc --noEmit`, `npm run build`. Backend: `cd intel; npm test` при настроенном PostgreSQL; Docker-вариант после build: `docker compose run --rm -T --no-deps osiris-intel npm test`. Тесты создают изолированные схемы и не подменяют production reports. CI продолжает Ubuntu/Windows frontend + настоящий PostgreSQL 16 backend.

Ограничения: optional providers без доступа не проверяются live; нет готового официального глобального coverage, административных polygon datasets, автоматического witness feed, полноценного акустического/terrain solver или доказанной независимости всех OSINT-перепечаток. Эти пробелы отображаются, не заменяются вымышленными данными.

Связка Live Alerts, retained map API, значки и точные ограничения: [MilitaryEventAggregation.md](MilitaryEventAggregation.md).
