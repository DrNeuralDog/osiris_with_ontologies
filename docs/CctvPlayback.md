# CCTV: воспроизведение и диагностика

Проверено 22.09.2026 в Windows 11 / Docker Desktop. Изменения относятся к CCTV; новый оперативный military-event aggregation pipeline в этом проходе не реализован.

## Устройство

`camera catalog → ID lookup → CameraViewer → CameraMedia → HLS / native video / iframe / snapshot`

- `CameraViewer` сохраняет существующие InvestigationActions, координаты, полноэкранный режим и закрытие. Диагностика раскрывается отдельно.
- `CameraMedia` разделяет жизненный цикл снимка, HLS/MP4, MJPEG и iframe. Смена камеры, Retry и закрытие уничтожают предыдущий транспорт.
- `camera-playback.ts` содержит тестируемый HLS lifecycle и выбор fallback. Manifest/metadata/HTTP 200 не подтверждают воспроизведение. Требуется decoded `playing` либо продвижение `currentTime` с ненулевой шириной кадра.
- Максимум 15 секунд на старт и 15 секунд без продвижения играющего видео. HLS: ограниченные manifest/segment retry, одна media recovery, остановка/destroy при исчерпании попыток.
- Снимки обновляются каждые 15 секунд; загрузка ограничена 15 секундами. При ошибке обновления последний полученный снимок остаётся с явной пометкой. Записи видео нет.
- MP4 поддержан в каталожном типе. Это видеоролик с неподтверждённым временем съёмки, а не доказанная прямая трансляция.

## Честные состояния

`SNAPSHOT_AVAILABLE`, `SNAPSHOT_UNAVAILABLE`, `SNAPSHOT_STALE` относятся только к изображениям.

`STREAM_AVAILABLE`, `STREAM_BLOCKED`, `STREAM_OFFLINE`, `STREAM_UNSUPPORTED`, `EXTERNAL_ONLY`, `UNKNOWN` относятся к браузерному видео. Доступность означает подтверждённое воспроизведение в проверенной сессии; завершившийся MP4 остаётся доступным роликом. Сетевая ошибка не доказывает, что камера выключена физически. Браузер часто не различает CORS и сетевой отказ, поэтому показывается `NETWORK_OR_CORS`, а не выдуманная точная причина.

При отказе HLS/MP4 с отдельным `feed_url` viewer автоматически переходит на снимок. Подпись «ВИДЕО НЕДОСТУПНО · ПОКАЗАН СНИМОК» появляется после получения изображения. Доступны повтор видео и открытие источника. External-only не показывает spinner или бессмысленную кнопку обновления отсутствующего снимка.

Iframe `load` означает только загрузку документа: общий iframe остаётся `UNKNOWN / PLAYBACK UNVERIFIED`. Для YouTube используется официальный IFrame API, его `PLAYING`, ошибки и autoplay callbacks. На старте iframe действует 15-секундный deadline. Первый кадр MJPEG подтверждается отдельно, но загрузка одной картинки не выдаётся за доказательство непрерывного движения.

## API и безопасность

- Региональные ответы `/api/cctv` сразу пополняют bounded ID index; для поиска одной камеры больше не требуется предварительно построить глобальный payload.
- `GET /api/cctv/camera?id=…` — только ID локального каталога, максимум 200 символов, 60 запросов/мин, bounded lookup, без global fan-out. На холодном каталоге вернуть `NOT_AVAILABLE` и предложить загрузить регион карты.
- `/camera?id=…` — отдельный viewer для воспроизводимой диагностики той же камерой и тем же компонентом. URL потока от пользователя не принимается.
- `GET /api/cctv/resolve?url=…` — только прежние публичные Skyline / YouTube channel-live страницы. HTTPS, allowlist, проверка redirect/DNS, максимум 2 redirect, 2 MiB, 10 секунд; coalescing до четырёх запросов. Положительный результат кешируется 30 минут, offline/unknown 5 минут, network failure 30 секунд. Ответ `no-store`: CDN не растягивает отрицательный кеш.
- Skyline HLS с токенами не извлекается и не проксируется. Разрешён переход к операторскому YouTube embed, уже опубликованному на странице. Numeric snapshot ID проверяется по `og:image` текущей страницы: переиспользованная картинка другого места скрывается. При отсутствии подтверждения UI честно указывает неизвестную принадлежность.
- Image proxy сохраняет существующий allowlist, проверяет каждый redirect и адрес, закрепляет проверенный IP для сокета, сохраняет TLS verification. DNS до 4 секунд, вся загрузка до 14 секунд, 2 MiB, максимум 2 redirect. На нашем origin возвращаются только распознанные raster image bytes; HTML/SVG не отдаются как активный контент.
- Новый универсальный video/HLS proxy не добавлен. Ограничения доступа провайдеров не обходятся.
- Legacy `/api/cctv/stream-status` теперь сообщает `document_available` отдельно от видео; HTTP 200 страницы rtsp.me оставляет видео UNKNOWN. Запросы bounded, redirects не следуются.

`POST /api/intelligence/camera-check?id=…` продолжает использовать только каталог, same-origin, rate limit и persistent backoff. Он может проверить отдельный JPEG у HLS-камеры, но **никогда не устанавливает STREAM_AVAILABLE**. Migration 009 добавляет `intelligence_sources.camera_media` JSONB, существующие history/ontology не меняются. Source Health показывает snapshot/video отдельно. Healthy only по-прежнему означает недавнюю успешную проверку кадра, не видеотрансляции; неизвестные камеры туда не входят.

## Проверка реальных источников

Production Docker, 22.09.2026 около 10:07–10:26 МСК. Ни одна камера или observation не добавлялась в БД искусственно. Каталог прогревался штатным API. Значения описывают конкретную проверку, не SLA источника.

| Камера / provider | Формат | Результат |
|---|---|---|
| `pl-nadm-2`, nadmorski24 | HLS | 1920px, первый кадр 2750 мс; currentTime 11.30 → 21.22 |
| `bg-burgas-center`, Smart Burgas | HLS | 1920px, 2372 мс; currentTime 73.51 → 110.55 |
| `rs-kalotina-gradina-1`, AMSS | HLS | 640px, 1365 мс; currentTime 305.70 → 314.90 |
| `ndot-2`, Nevada DOT | HLS + JPEG | Startup timeout; видео удалено, автоматически показан JPEG 360px. Screenshot подтвердил отдельную подпись fallback |
| `indot-22573`, Indiana DOT | HLS | NETWORK_OR_CORS; остановка и понятное состояние без spinner |
| `tfl-JamCams_00002.00865`, TfL | JPEG | Изображение 352px. Серверная проверка сохранила SNAPSHOT_AVAILABLE / video UNKNOWN |
| `tor-open-8001`, Toronto | JPEG | Изображение 320px |
| `bc-cam-848`, DriveBC | JPEG | Изображение 720px |
| `quebec511-4057`, Quebec 511 | MP4 | Первый кадр 739 мс, видео 320px дошло до currentTime=5 / ended=true. Подпись исправлена на видеоролик |
| `occ-taiwan-freeway-CCTV-N1-N-178-O-NE-1` | MJPEG | Старт не подтверждён за deadline; fallback-состояние без вечной загрузки |
| `pl-slupsk-1`, Słupsk | MJPEG | В этой среде кадр не получен; ограниченный отказ |
| `jp-shibuya-crossing`, ANN / YouTube | iframe | EMBED_TIMEOUT; воспроизведение не подтверждено |
| `th-bangkok-sukhumvit-soi-11`, YouTube | iframe | EMBED_TIMEOUT; воспроизведение не подтверждено |
| `gr-aodos-cam128`, IPCamLive | iframe | EMBED_TIMEOUT. Прямое открытие provider player тоже показало «Не удалось воспроизвести медиафайл» |
| `pubcam-netherlands-nieuwegein-down-under-recreatie`, rtsp.me | iframe | EMBED_TIMEOUT; воспроизведение не подтверждено |
| `sky-it-navona`, Skyline | image + external HLS | Snapshot загрузился, resolver hls/external-only. Self-review обнаружил несовпадение catalog live343 с page social177; теперь такой снимок блокируется |
| `sky-japan-amakusa-japan-5486`, Skyline | source → YouTube | Публичная страница содержит videoId, но resolver периодически не проходит DNS в Docker; не выдаётся за offline навечно |
| `cincinnati-covington-earthcam`, EarthCam | external-only | Сразу ссылка на источник без spinner |

У Skyline/Trevi/Pantheon/Colosseum наблюдались временные resolver failures; их нельзя честно назвать двумя заведомо выключенными камерами. Offline/missing проверены fixture-тестами, искусственные production camera records не создавались. Полный критерий успешного live playback нескольких iframe-провайдеров в этой среде пока не подтверждён. Основной дефект бесконечного ожидания и fallback воспроизведён и проверен на реальном NDOT.

## Проверки и ограничения

Unit/regression: manifest != playback, fatal/media/network failures, deadline, camera switch, Retry, snapshot fallback, iframe semantics, MP4, source image identity, no arbitrary URL, DNS/redirect/size limits, resolver TTL, independent snapshot/video persistence. Live network не требуется CI. PostgreSQL тест проверяет additive migration и запрет server-side false video certification.

Source availability, региональная блокировка, browser autoplay и разрешение provider на embedding остаются внешними условиями. Таймаут гарантирует выход из loading, но не делает чужую камеру доступной. Сервер не собирает массовую телеметрию playback всех посетителей. Никаких protected stream re-streaming или записи нет.

## Первичные источники

Документация просмотрена 22.09.2026:
- [Hls.js API](https://github.com/video-dev/hls.js/blob/master/docs/API.md)
- [YouTube IFrame API: events и ошибки](https://developers.google.com/youtube/iframe_api_reference)
- [rtsp.me: разрешённое встраивание](https://rtsp.me/en/how-to-embed-stream-on-website.html)
- [IPCamLive customized player](https://www.ipcamlive.com/resources/api/IPCamLiveCustomizedPlayer.pdf)
- [Skyline terms](https://www.skylinewebcams.com/terms-of-use.html)

## Итоговая валидация

- Frontend: baseline 929 passed, итог 954 passed; те же 20 прежних opt-in skipped, 0 failed. Новые проверки не требуют live-сети.
- Backend: baseline 115 passed, итог 116 passed, 0 skipped, настоящий PostgreSQL 16.
- Scoped ESLint новой/изменённой CCTV-логики, TypeScript и production build Windows/Linux Docker прошли. Старый несвязанный lint debt не объявляется устранённым.
- `docker compose up -d --build` и обычный `docker compose up -d`: frontend/intel/PostgreSQL healthy, cache running; порт 3000 и BAT не изменены.
- Старые CMP815 UUID/created_at, Case и история сохранены; миграции 001–009 присутствуют. Никакой очистки volume не было.
- Финальный региональный каталог: 4185 реально полученных записей; четыре ID lookup — 7–12 мс. Полного world fetch ради lookup нет.
- HTTP `/`, health, graph, object history, sources — 200. У summary повторился известный cold-start 502 (BUG-005), повтор — 200 / 174 мс; history 38 мс, sources 28 мс.
- В финальном браузерном повторе NDOT снова перешёл на настоящий JPEG после timeout, Skyline неподтверждённый снимок скрыт, HLS Gdynia двигался currentTime 68.99 → 96.05. Доступность MP4 изменчива: первоначально ролик успешно проигран, при одном повторе источник дал MEDIA_ERR_SRC_NOT_SUPPORTED; последующий Retry успешно проиграл ролик до currentTime=5 / ended=true с новой подписью «ВИДЕОРОЛИК · ВРЕМЯ СЪЁМКИ НЕ ПОДТВЕРЖДЕНО». Это не постоянная гарантия доступности.
- GitHub Actions workflow сохранён. Удалённые CI jobs не запускались, commit/push не выполнялись. Все изменения оставлены в development.
