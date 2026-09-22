# Погодные поля: исправление сквозного отображения

Проверено по [документации Open-Meteo](https://open-meteo.com/en/docs) и [тарифам/условиям](https://open-meteo.com/en/pricing) 22.09.2026. Free API допускает некоммерческое использование без ключа. Customer endpoint предназначен для совместимого ключа подписки. Исходные данные требуют атрибуции Open-Meteo / CC BY 4.0.

## Цепочка данных

`Open-Meteo forecast → boundedJSON / ProviderCache → normalizeWeather → /api/world/weather → WeatherOverlay → MapLibre fill / symbol`

`WorldLayers` сохраняет существующие объекты, investigation popup и независимый RainViewer. Новая логика находится в `weather-grid.ts`, `weather-field.ts`, `weather-renderer.ts`, `weather-types.ts`, `WeatherOverlay.tsx`. Renderer повторно прикрепляет те же данные при `style.load`, без повторного запроса провайдера. Геометрия MapLibre поддерживает globe/mercator и terrain; стрелки остаются экранного размера.

## Настройки и API

`GET /api/world/weather?bbox=W,S,E,N&zoom=8&quality=standard`

- `zoom`: конечное число 0–22, по умолчанию 5.
- `quality`: `standard` или `low` (до 36 точек для небольшого экрана/слабого устройства).
- bbox: текущие ограничения World API, долгота ±180°, широта ±85°; дубликаты и неизвестные параметры отклоняются.
- `OPEN_METEO_API_MODE=free` по умолчанию. Само наличие `OPEN_METEO_API_KEY` больше не меняет endpoint.
- `OPEN_METEO_API_MODE=customer` требует непустого совместимого ключа `OPEN_METEO_API_KEY`. Отсутствие/placeholder означает `CUSTOMER_KEY_REQUIRED`; HTTP 401/403 явно возвращается в диагностике. Автоматического перехода с customer на free нет. Реальную совместимость ключа подтверждает провайдер, а не проверка строки.
- В ответе `records`, `grid`, `diagnostics`: endpoint mode, provider status, cache state, requested/received/normalized counts, fetched/model time, HTTP error, retry delay. При недоступности без кэша — HTTP 503 с диагностикой, при malformed input — 400.
- Секреты и URL с ключом не возвращаются клиенту. Upstream hosts фиксированы; redirects запрещены, timeout 20 секунд, JSON до 1 MiB.

## Сетка, значения и визуализация

Сетка учитывает zoom, соотношение сторон viewport в Mercator и бюджет устройства: базовая сторона 5/7/9 для world/country, regional и city; жёсткий максимум 9×9 = 81 точка. Координаты запрашиваются **одним batch**. Крайние точки покрывают границы viewport. Это сетка запросов, а не разрешение метеомодели.

Все восемь current-полей сохранены: температура, влажность, осадки, облачность, давление MSL, скорость/направление ветра на 10 м, порывы. Visibility берётся из соответствующего часа и имеет отдельный timestamp. Ветер запрашивается в m/s. `cell_selection=nearest`; реальные координаты модельной ячейки хранятся отдельно от координат запроса. Best-match выбирает модель по региону; точное native resolution не выдумывается.

Scalar-поле: bilinear-интерполяция до **64×48 = 3072 WebGL fill-ячеек**, без отдельных DOM markers. Missing corners дают пробел; отсутствующее значение не заменяется нулём. Нулевые осадки остаются нулевыми осадками. Легенда содержит фиксированную цветовую шкалу и фактический диапазон samples. Интерполяция используется только для отображения — не сохраняется как observations и не участвует в correlations.

Wind: до 81 стрелки на исходных точках, размер **18–42 экранных пикселя**. Направление — куда дует ветер (`wind_from + 180°`). При скорости <0.1 m/s рисуется кружок штиля. Порывы, влажность и provenance доступны в свойствах точки. Клик по интерполированной ячейке открывает ближайшую исходную модельную точку, а не создаёт запись о вымышленном измерении.

Одновременно активно одно scalar-поле; ветер и RainViewer независимы. Все layer visibility переключаются явно. В World Replay текущие модельные поля скрываются, сохранённые наблюдения обслуживаются прежней temporal architecture.

## Ограничения производительности и кэш

- Debounce viewport: 900 ms. Polling: 120 s; при throttling используется provider retry delay. Запросов на animation frame нет.
- Во время перемещения/восстановления вида запрос ждёт остановки карты. Browser fetch имеет высокий приоритет и предел 45 секунд; при активной погоде параллельная загрузка изображений MapLibre ограничена четырьмя запросами, прежний бюджет восстанавливается после выключения. Transport `fetch failed` повторяется один раз; HTTP credential/quota errors не повторяются.
- Cache TTL 10 min, до 24 grids/endpoint, коалесинг одинаковых запросов; новые batches не чаще 5 секунд, один in-flight на endpoint.
- До 100 новых batches/сутки/процесс/endpoint, максимум 8100 запрошенных координат. Это локальная защита, не гарантия остатка общей upstream-квоты: другие части системы/клиенты могут использовать тот же IP/аккаунт. После рестарта process-local бюджет сбрасывается.
- После upstream failure — exponential backoff от 2 минут до часа. Для того же viewport и credential возможен stale-good до 30 минут, явно `STALE / DEGRADED`; чужая область не подставляется. Cache hit не засчитывается как новый Source Health success.
- История ontology, БД и telemetry retention не меняются. Docker volume и launcher сохранены.
- RainViewer использует собственные metadata/cache/tiles. Ошибка очередного обновления не удаляет последний успешно полученный кадр; его исходное время остаётся видимым.

## Проверки

Fixture-тесты проверяют multi-location (>16), все поля и unknown confidence, free/customer, HTTP 401 без утечки ключа, пустой ответ, coalescing/cache/stale, adaptive bounds, missing data, размер/направление стрелок, switching, style reload и видимость ошибок. World API проверяет query limits и передачу диагностики.

### Реальная проверка 22.09.2026

- Free endpoint: прямой multi-coordinate HTTP 200 с восемью current-полями и hourly visibility; запрос из Docker также 200. Рабочий платный customer key отсутствовал: customer 401 и missing credential проверены fixtures, успешный live customer access не заявляется.
- Региональный API: 49/49 записей, новый запрос 0.87–0.98 s, upstream около 0.62 s; повтор из кэша 17 ms. Мировая сетка: 24 точки, около 1.03 s. City/low: 30 точек, provider duration 570 ms. Это отдельные измерения, не SLA.
- Финальный HTTP smoke 11:12 UTC: Open-Meteo HTTP 200, 49/49, MISS, duration 290 ms; RainViewer AVAILABLE / 12 frames; оба `world:*` источника HEALTHY в Intel Source Health, Intel database ok.
- Production browser: региональная сетка 63/63, 3072 fill-ячеек, 63 стрелки. По очереди визуально проверены температура, осадки, облачность, visibility и давление. Нулевые осадки честно дают нулевое поле. Wind OFF удаляет стрелки, scalar OFF удаляет поле. RainViewer отображал реальные радарные пятна совместно с Open-Meteo.
- World zoom 2.5: 28 точек и различимые стрелки/поле; city zoom 16: 63 точки. Переключения спутник/ночная карта, globe/mercator, terrain ON/OFF сохранили отображение. `style.load` reattachment дополнительно проверен тестом renderer.
- После reload последней сборки снова получены 63/63 реальные записи, источник HEALTHY; температура 2.7–13.9 °C. При холодном старте карты наблюдалась задержка порядка минуты до подтверждённой визуализации, при последующих переключениях используется уже загруженная сетка. Внешние tile/provider задержки не объявляются устранёнными; loading/error ограничены и видны.
- World Replay скрывает текущие поля: DOM renderer counters 0 cells / 0 arrows. Return to Live восстановил 3072 / 63, layer preferences и существующий Case context сохранились. RainViewer выбрал собственный доступный исторический кадр.
- Windows frontend: 985 passed, 20 прежних opt-in skipped, 0 failed. Linux Node 22 в Docker builder: те же 985/20/0. Intel/PostgreSQL: 125 passed, 0 skipped. Scoped ESLint погодной логики чистый, Windows production build и Docker build прошли. Существующий legacy lint debt `LayerPanel` (3 any errors) не скрывается и не относится к новой погодной логике.
- `docker compose up -d --build`, затем прежний `docker compose up -d`: frontend/intel/PostgreSQL healthy, cache running; port 3000 сохранён. Старый canonical CMP815 UUID и created_at проверены в БД, volume не удалялся. GitHub workflow не менялся; удалённые CI jobs в этом проходе не запускались.
