# PiPlayer — подробный план реализации v2

**Назначение:** самостоятельное техническое задание для coding agent.  
**Дата:** 7 сентября 2026 года.  
**Стек:** .NET 10 / ASP.NET Core, Angular, SignalR, Chromium kiosk.  
**Хранение:** JSON и медиафайлы рядом с приложением, без базы данных.  
**Статус:** план разработки; проверка на конкретной Raspberry Pi ещё не выполнена.

> Это переработанная версия приложенного `pi-player-coding-agent-plan(1)(1).md`.
> Сохранены назначение приложения, стек, файловое хранение, библиотеки, пресеты,
> независимые настройки автозапуска и поэтапная реализация.
> Главная переработка: вместо `Animation + Music` используются независимые
> `Visual + Audio`. YouTube относится к Visual, а не к фоновой музыке.
> Все значения лимитов, интервалы, схемы и правила поведения ниже — проектные решения,
> если рядом прямо не указана ссылка на внешнюю документацию.

## Как пользоваться документом

Разделы 1–6 определяют поведение и модель данных, 7–18 — реализацию, 19 — установку,
20–24 — порядок работ и приёмку, 25 — готовую инструкцию coding agent.
В разделе 26 перечислены проверенные внешние источники. Обозначения `[R1]`–`[R12]`
ссылаются на этот раздел.

При конфликте примера и текстового правила руководствоваться правилом и исправлять
пример вместе с тестами. Не оставлять в реализации старые имена `animation` там,
где новая модель должна поддерживать и локальное видео, и YouTube.

### Принятые допущения, а не подтверждённые характеристики устройства

| Параметр | Решение для этой версии |
|---|---|
| Количество устройств | Одна Raspberry Pi и один подключённый экран. |
| Видеослои | Один активный Visual одновременно. Это допущение MVP. |
| Дополнительный звук | Один независимый канал Audio; звук самого видео может играть одновременно. |
| Модель Pi / RAM | Неизвестны. Не обещать конкретную производительность до проверки. |
| ОС / графическая среда | Неизвестны. Эталонная инструкция — для 64-битной Raspberry Pi OS Desktop с labwc; установщик обязан определить фактическое окружение. |
| Разрешение | Определяется `/screen`, не зашивается как 1920×1080. |
| Выход звука | Системное устройство вывода, выбранное при установке; HDMI/USB/другое уточняется диагностикой. |
| SSH | Для установки без клавиатуры нужен рабочий удалённый доступ. Его наличие пока не подтверждено. |
| Локальные файлы | Загружаются через admin и сохраняются на Pi. Автоматический просмотр внешней USB-флешки не входит в MVP. |
| Сеть | Управление внутри LAN; интернет нужен только для внешних источников. |

Разработку не блокировать вопросами об этих параметрах: вынести зависимые настройки
в конфигурацию и подготовить диагностику. Но аппаратную приёмку нельзя отметить
выполненной без реального устройства.

---

## 1. Цель и пользовательские сценарии

### 1.1. Что должна делать Raspberry Pi

После подачи питания система самостоятельно запускает backend, графическую сессию
и Chromium на весь экран с адресом `http://localhost:5000/screen`.
Локальная клавиатура и мышь для обычной работы не нужны.

Экран должен уметь показывать один видеослой из локального файла или YouTube,
менять его расположение, размер и поддерживаемые преобразования, воспроизводить
или отключать звук видео. Отдельно можно включать фоновое аудио из локального файла
или прямого веб-источника.

Закрытие браузера на Windows не должно останавливать воспроизведение на Pi.
Admin — пульт, а не источник видеопотока.

### 1.2. Что должно быть доступно с Windows

Пользователь открывает `http://<pi-hostname-or-ip>:5000/admin` и получает:

- библиотеки локального видео и локальной музыки: загрузка, список, переименование,
  удаление и выбор;
- управление источником Visual, положением, размером, масштабом, поворотом,
  прозрачностью и воспроизведением;
- независимые громкость и mute для Visual и Audio;
- ввод YouTube video/playlist URL и прямого audio URL;
- пропорциональную схему реального экрана с перетаскиванием и числовыми полями;
- сохранение, применение, переименование и удаление Visual/Audio-пресетов;
- независимый выбор стартовых пресетов;
- фактический статус плееров и понятные ошибки.

### 1.3. Основной проверочный сценарий

1. Загрузить локальный MP4 через admin.
2. Выбрать его как Visual.
3. Установить `x=100`, `y=20`, `width=800`, `height=450`, `scale=1`,
   `rotation=33`.
4. Получить на Pi видео с указанным преобразованием.
5. Выключить звук видео.
6. Включить локальную музыку или прямой аудиопоток.
7. Сохранить оба пресета и назначить их стартовыми.
8. Перезагрузить Pi и получить воспроизведение без локального нажатия.

Для YouTube воспроизведение и геометрия проверяются отдельно с учётом раздела 15.
Произвольный поворот локального видео — обязательная функция. Поворот YouTube
контейнера — отдельный проверяемый риск, а не обещание официального API.

### 1.4. Границы MVP

Обязательны видеофайлы `.mp4` и `.webm`; GIF, Lottie, Canvas-анимации, SVG-анимации
и последовательности изображений не нужны. Декодирование конкретного файла
зависит не только от расширения: фактическую совместимость проверять на Pi.

Многослойную композицию, несколько дисплеев, монтажный timeline, cloud sync
и автоматическое обновление приложения не реализовывать.

---

## 2. Продуктовая модель: независимые Visual и Audio

### 2.1. Visual

Visual — один отображаемый видеослой. Поддерживаемые источники:

```text
localVideo
youtubeVideo
youtubePlaylist
```

У Visual есть источник, геометрия, видимость, состояние воспроизведения,
loop, playbackRate, muted и volume.

Для `localVideo` используется `<video>`. Для YouTube — официальный IFrame Player API.
Произвольные iframe или HTML от пользователя не принимаются.

### 2.2. Audio

Audio — независимая фоновая звуковая дорожка:

```text
localFile
remoteAudioUrl
```

Она воспроизводится через `<audio>` на `/screen`, а не в admin.

`remoteAudioUrl` — прямой URL аудиофайла или совместимого непрерывного аудиопотока.
Обычная веб-страница музыкального сервиса не является таким источником.
Spotify, YouTube Music и произвольные страницы с собственными плеерами
не объявляются поддерживаемыми.

В исходном плане локальные плейлисты были упомянуты, но не имели законченного
контракта. Здесь они явно **отложены после MVP**. YouTube-плейлисты сохранены
в составе Visual. Не создавать неработающий `localPlaylist` в DTO или UI.

### 2.3. Независимость каналов

| Действие | Visual | Audio |
|---|---|---|
| Включить локальную музыку | Не менять. | Выбрать и запустить локальный файл. |
| Включить прямой audio URL | Не менять. | Остановить прежний Audio, запустить новый. |
| Включить YouTube | Заменить прежний Visual. | Продолжить без изменений. |
| Включить локальное видео | Заменить прежний Visual. | Продолжить без изменений. |
| Mute видео | Изменить только Visual.muted. | Не менять. |
| Pause видео | Приостановить Visual. | Не менять. |
| Stop music | Не менять. | Остановить Audio. |
| Stop all | Остановить оба канала; сохранить выбранные источники и геометрию. | Остановить Audio. |
| Clear screen | Убрать источник Visual и показать фон. | Не менять. |

Оба канала могут быть слышны одновременно. Приложение не делает автоматический
ducking и не пытается синхронизировать музыку с видео по кадрам.
В UI предупреждать, когда оба источника не muted, но не отключать их самовольно.

Начальные значения: Visual muted; Audio не muted, но не запускается без настройки
или команды. Громкости сохраняются независимо.

### 2.4. Обязательные ограничения YouTube

Использовать только официальный встроенный плеер. Не скачивать видео, не извлекать
аудио, не превращать скрытый iframe в музыкальный проигрыватель.
Эти ограничения основаны на документации и правилах YouTube. [R2]

Минимальный viewport встроенного плеера — 200×200 CSS px. Нельзя перекрывать его
элементы интерфейсом приложения. Для автоматического воспроизведения должно быть
видно больше половины плеера; одновременно автоматически играть может не более
одного YouTube-плеера на странице. [R1]

**Проектное ужесточение:** в обычном режиме PiPlayer требовать полностью видимый
YouTube-плеер, opacity=1 и отсутствие обрезки. Это правило приложения, а не
утверждение, что YouTube требует именно 100% видимости.

### 2.5. Риск поворота YouTube

Внешний CSS-контейнер технически можно спроектировать с поворотом, но официальная
документация IFrame API не предоставляет параметр произвольного поворота, а правила
ограничивают недокументированные изменения вида плеера. Поэтому нельзя объявлять
YouTube и локальный `<video>` полностью равноценными по transform. [R1][R3]

План реализации:

1. Общую геометрию и UI строить через capabilities, не через два несвязанных редактора.
2. Для локального видео поддерживать поворот сразу.
3. Для YouTube выполнить отдельный prototype поворота всего контейнера без изменения
   содержимого iframe, скрытия элементов, рекламы или branding.
4. Проверить актуальные требования сервиса и поведение на целевой Pi.
5. По умолчанию `EnableExperimentalYouTubeRotation=false`.
6. Включать экспериментальную возможность только явно, после проверки; UI должен
   показывать её статус. Успех CSS-теста сам по себе не является подтверждением
   соответствия правилам сервиса.
7. Если проверка не пройдена, YouTube остаётся с позиционированием и изменением
   размера, но без поворота. Это ограничение отражается в README и приёмке,
   а не скрывается за отметкой «всё реализовано».

---

## 3. Архитектура верхнего уровня

### 3.1. Компоненты

```text
Windows browser
  /admin
     |
     | REST: библиотеки, пресеты, настройки
     | SignalR: команды, snapshots, наблюдаемый статус
     v
Raspberry Pi: PiPlayer.Server
  ASP.NET Core
  CommandDispatcher / RuntimeStateService
  JsonFileStore / MediaLibraryService
  ScreenHub / ScreenSessionRegistry
     |
     | localhost HTTP + SignalR
     v
Raspberry Pi: Chromium kiosk
  /screen
  VisualRenderer
    LocalVideoAdapter OR YouTubeAdapter
  AudioRenderer
    HtmlAudioAdapter
     |
     v
Подключённый экран + системный аудиовыход
```

Backend обслуживает Angular, API, SignalR и безопасные маршруты медиа.
Медиафайлы не пересылаются через SignalR.

### 3.2. Единый путь изменения состояния

Любая команда из REST или SignalR проходит один и тот же backend dispatcher:

```text
Authentication / Authorization
  -> DTO validation
  -> source / capability / geometry validation
  -> command deduplication and conflict checks
  -> state reducer
  -> new desired snapshot with revision
  -> screen reconciliation
  -> observed playback report
  -> admin status
```

Не реализовывать отдельную бизнес-логику воспроизведения в контроллерах и Hub.
Не позволять admin напрямую отправлять команды другому браузеру без backend.

### 3.3. Desired и observed — разные сущности

**Desired state** — что пользователь запросил: источник, transform, громкость,
play/pause/stop.

**Observed state** — что реально произошло на Pi: loading, playing, paused,
buffering, blocked, ended, error, текущее время и фактическая громкость.

Принятая команда не доказывает, что началось воспроизведение.
Admin должен показывать, например:

```text
Запрошено: playing
Фактически: blocked
Причина: autoplayBlocked
```

### 3.4. Единственный активный экран

В production допускается один авторизованный `/screen` с `deviceId=primary`.
Второй просмотр `/screen` на Windows не должен случайно запускать звук и
становиться реальным управляемым экраном.

Preview в admin — визуальная модель сцены, не ещё один screen-клиент.
Синхронный видеострим экрана, VNC и screen capture не требуются.

### 3.5. Технологические решения

Backend — `net10.0`, ASP.NET Core shared framework, System.Text.Json.
Frontend — Angular standalone application с отдельными lazy routes.
Версии Angular, Node.js и TypeScript выбрать по официальной таблице совместимости
и закрепить lockfile; не использовать незакреплённый `latest` в воспроизводимой
сборке. [R11]

Клиент SignalR — официальный `@microsoft/signalr`, закреплённый совместимой версией.
Не добавлять устаревшие NuGet-пакеты ASP.NET Core только потому, что их имена
встречались в предыдущем плане.

---

## 4. Runtime flow, запуск и восстановление

### 4.1. Холодный запуск Raspberry Pi

1. ОС загружает системные службы.
2. `systemd` запускает PiPlayer.Server от непривилегированного пользователя.
3. Backend создаёт новый `serverInstanceId`.
4. Backend проверяет config, каталоги, JSON и доступность записи.
5. До объявления readiness backend один раз формирует начальный desired state.
6. Графическая сессия автоматически входит под kiosk-пользователем.
7. `start-kiosk.sh` ожидает успешный `/api/system/ready`.
8. Chromium запускается на `/screen` в отдельном постоянном browser profile.
9. `/screen` получает локальную screen-сессию, подключается к SignalR и сообщает
   готовность оболочки и параметры viewport.
10. Backend возвращает текущее состояние. Клиент инициализирует необходимые
    media adapters и подтверждает фактические результаты.
11. Windows admin может подключиться до или после этого.

Shell-ready не должен ждать загрузки YouTube API: недоступность интернета не может
блокировать локальное видео, локальную музыку и управление.

### 4.2. Политика startup

В настройках поддержать:

```text
startupMode = defaults | resumeLast
```

`defaults` — стандартный режим. При каждом запуске процесса backend применяются
назначенные стартовые Visual/Audio-пресеты. Каждый канал включается независимо.

`resumeLast` — восстановить последний сохранённый desired state и совместимые
playback checkpoints. Если сохранение отсутствует или невалидно, использовать
defaults и сообщить предупреждение.

Это выбор поведения при запуске **backend**, не при каждом соединении браузера.

### 4.3. Reconnect без перезагрузки `/screen`

Если SignalR временно потерял соединение, уже загруженный media element продолжает
работать в пределах действующей screen lease, насколько доступен его источник.
После reconnect:

1. Клиент повторяет авторизованную регистрацию.
2. Сообщает текущий `pageSessionId`, последний `serverInstanceId` и `revision`.
3. Backend отправляет актуальный полный snapshot.
4. Если источник и playbackGeneration не менялись, не пересоздавать плеер,
   не сбрасывать позицию и не вызывать повторный `load()`.
5. Применить только изменившиеся поля.
6. Отправить свежий observed state.

`ScreenReady` не вызывает startup defaults повторно.
Автоматический reconnect SignalR не заменяет обработку ошибки самого первого
`connection.start()`; оба пути нужно реализовать. [R6]

### 4.4. Перезагрузка страницы или падение Chromium

Новая страница имеет новый `pageSessionId`. Она получает текущее desired state,
а не startup defaults.

Позицию восстанавливать из последнего checkpoint, если совпадают источник
и playbackGeneration. Для live audio возвращаться к текущему live-потоку,
а не пытаться перемотать к старой секунде.

В MVP не компенсировать время простоя математически: восстановление с checkpoint
допускает повтор нескольких секунд. Не обещать бесшовный loop или frame-accurate resume.

### 4.5. Перезапуск backend

Новый `serverInstanceId` означает новый runtime-сеанс. Применяется `startupMode`.
Уже открытый `/screen` после восстановления связи принимает новый snapshot как
новую базу, даже если числовые revision случайно совпали.

### 4.6. Если экран offline

Backend может принимать устойчивые настройки: источник, геометрию, громкость,
desired transport. В admin показывать `accepted / screen offline`, а не `playing`.

После подключения отправлять итоговое desired state, не воспроизводить весь
накопленный журнал кликов. `playlistNext` / `playlistPrevious` без актуального
observed playlist context отклонять: эти действия нельзя надёжно разрешить offline.

### 4.7. Независимые ошибки

Ошибка YouTube не останавливает Audio. Ошибка музыки не убирает Visual.
Отсутствие интернета не мешает доступу к локальной библиотеке.
Отсутствующий стартовый preset пропускается только для своего канала.

### 4.8. Повторные подключения admin

Admin заново читает snapshots и библиотеки; закрытие или обновление admin
не влияет на плееры. Допускается несколько admin-вкладок. Конфликты изменений
обрабатываются revision, а не скрытой перезаписью устаревшей формы.

---

## 5. Каталоги и данные рядом с приложением

```text
/opt/pi-player/
  PiPlayer.Server
  PiPlayer.Server.dll
  appsettings.json
  wwwroot/
  scripts/
    start-kiosk.sh
    install-systemd.sh
    configure-kiosk.sh
    preflight.sh
  data/
    settings/
      startup-settings.json
      runtime-state.json
    presets/
      visual-presets.json
      audio-presets.json
    library/
      video-library.json
      audio-library.json
    media/
      videos/
        <generated-id>.mp4
        <generated-id>.webm
      audio/
        <generated-id>.mp3
    uploads/
      <upload-id>.partial
    trash/
      <pending-deletion-files>
    security/
      admin-password.json
      data-protection/
    diagnostics/
      hardware-profile.json
      compatibility-report.json
    logs/
```

Отдельно, в домашнем каталоге kiosk-пользователя:

```text
~/.local/share/pi-player/chromium-profile/
~/.config/pi-player/kiosk.conf
```

Browser profile не включать в обычный экспорт библиотеки: там могут быть cookies.

### 5.1. Разрешение путей

Значение по умолчанию:

```csharp
Path.Combine(AppContext.BaseDirectory, "data")
```

Относительный `PiPlayer:DataPath` тоже вычислять относительно `AppContext.BaseDirectory`,
а не текущей shell-директории. Абсолютный путь допускается через конфигурацию.

### 5.2. Правила файлового доступа

Публично не раздавать `data` целиком. JSON, backups, security, uploads, trash и logs
не должны открываться как static files.

Physical filename — сгенерированный ID и проверенное расширение.
Display name хранить отдельно. Пользователь не вводит пути, подпапки, shell-команды
или исходный HTML.

Бинарные файлы приложения могут быть root-owned и read-only для service user.
Записываемые данные принадлежат service user. Chromium не запускать от root.

### 5.3. Обновления и резервные копии

Ручной deploy заменяет бинарники, `wwwroot` и scripts, но не удаляет `data`.
Нельзя применять безусловный `rsync --delete` ко всему `/opt/pi-player`.

Для согласованной резервной копии в MVP остановить backend или использовать
эксклюзивную блокировку записи на время копирования JSON и медиа.
Живое копирование нескольких файлов не считать транзакционным snapshot.

При внешнем `DataPath` установщик обязан проверить mount и запись. Не создавать
«новую пустую библиотеку» на SD-карте, если ожидаемый внешний диск не смонтирован.

---

## 6. Модель данных и файловое хранение

### 6.1. Общие правила

У каждого постоянного документа есть `schemaVersion: 2`, `documentRevision`
и `updatedAtUtc`. Время — UTC ISO 8601, ID — UUID v7 в строковом виде.

Внутри JSON использовать camelCase и строковые discriminators. Значение `null`
означает отсутствие выбранного источника. Не подменять его пустым URL.

Неизвестную будущую schemaVersion не перезаписывать defaults.
Невалидные данные сохранять для диагностики и применять документированные
правила восстановления из `.bak`.

### 6.2. Источники Visual

```ts
type VisualSource =
  | { kind: 'localVideo'; assetId: string }
  | { kind: 'youtubeVideo'; videoId: string }
  | {
      kind: 'youtubePlaylist';
      playlistId: string;
      initialVideoId: string | null;
    };
```

Внешний URL нормализуется backend parser в такую структуру.
Для удобства редактирования можно хранить отдельно исходный display URL,
но он не становится произвольным iframe src.

### 6.3. Источники Audio

```ts
type AudioSource =
  | { kind: 'localFile'; assetId: string }
  | {
      kind: 'remoteAudioUrl';
      url: string;
      streamMode: 'auto' | 'file' | 'live';
    };
```

`streamMode` — подсказка и ограничение UX. Итоговая возможность seek определяется
реальным adapter. Указание `file` не заставляет сервер источника поддерживать seek.

### 6.4. Геометрия Visual

```json
{
  "x": 100,
  "y": 20,
  "width": 800,
  "height": 450,
  "scale": 1,
  "rotation": 33,
  "opacity": 1,
  "objectFit": "contain"
}
```

Контракт:

- все расстояния в CSS px координатного пространства `/screen`;
- `x/y` — позиция локального верхнего левого угла до поворота;
- `width/height` — размеры до scale и rotation;
- `scale` — равномерный множитель обеих сторон, а не повторно пересчитанные width/height;
- `rotation` — градусы по часовой стрелке в экранной системе координат;
- единственный pivot MVP — верхний левый угол;
- `objectFit` для localVideo: contain / cover / fill; default contain;
- для YouTube не обрезать и не растягивать содержимое iframe через objectFit.

Важно: после поворота минимальный X/Y видимого bounding box может отличаться
от `x/y`. В admin показать точку привязки и контур преобразованного прямоугольника.
Кнопка «Вписать в экран» использует все четыре преобразованных угла.

### 6.5. Playback configuration

```ts
interface VisualPlaybackConfig {
  loop: boolean;
  playbackRate: number;
  muted: boolean;
  volume: number; // 0..100
}

interface AudioPlaybackConfig {
  loop: boolean;
  muted: boolean;
  volume: number; // 0..100
}

type DesiredTransport = 'playing' | 'paused' | 'stopped';
```

Muted не стирает volume. Unmute возвращает ранее выбранную громкость.
Volume=0 и muted=true не считать одним и тем же сохранённым значением.

### 6.6. Desired runtime state

```json
{
  "visual": {
    "source": {
      "kind": "localVideo",
      "assetId": "01992000-0000-7000-8000-000000000001"
    },
    "visible": true,
    "transform": {
      "x": 100,
      "y": 20,
      "width": 800,
      "height": 450,
      "scale": 1,
      "rotation": 33,
      "opacity": 1,
      "objectFit": "contain"
    },
    "playback": {
      "loop": true,
      "playbackRate": 1,
      "muted": true,
      "volume": 70
    },
    "transport": "playing",
    "playbackGeneration": 4,
    "startPositionSeconds": 0,
    "startPlaylistIndex": null
  },
  "audio": {
    "source": {
      "kind": "localFile",
      "assetId": "01992000-0000-7000-8000-000000000002"
    },
    "playback": {
      "loop": true,
      "muted": false,
      "volume": 50
    },
    "transport": "playing",
    "playbackGeneration": 2,
    "startPositionSeconds": 0
  },
  "background": {
    "color": "#000000"
  }
}
```

`playbackGeneration` увеличивается при выборе/замене источника, restart,
явном seek, stop/reset и смене элемента playlist через admin.
Pause, resume, volume, muted и transform её не меняют.

`startPositionSeconds` применяется при новой generation или восстановлении
без подходящего checkpoint. Нельзя применять его на каждом snapshot:
иначе изменение громкости будет перематывать видео к началу.

Для null source transport всегда stopped. Поля transform и volume можно сохранять
как последние настройки редактора.

### 6.7. Observed runtime state

Для каждого канала:

```json
{
  "status": "playing",
  "sourceFingerprint": "localVideo:01992000-0000-7000-8000-000000000001",
  "playbackGeneration": 4,
  "positionSeconds": 12.4,
  "durationSeconds": 120,
  "seekable": true,
  "actualMuted": true,
  "actualVolume": 70,
  "actualPlaybackRate": 1,
  "currentVideoId": null,
  "playlistIndex": null,
  "playlistLength": null,
  "lastAppliedRevision": 42,
  "error": null
}
```

Допустимые status:

```text
idle
loading
ready
playing
paused
stopped
buffering
ended
blocked
error
```

Ошибка:

```json
{
  "code": "autoplayBlocked",
  "message": "Browser blocked playback without local user activation.",
  "providerCode": null,
  "retryable": false
}
```

Backend присваивает `receivedAtUtc`; клиентская дата не считается доверенным
источником порядка событий. Отчёты от старой page session или старой generation
игнорируются. ReportPlayback также передаёт текущие PlaybackCapabilities из 12.2.
Для playlist navigation нужны свежие playlistIndex и playlistLength.
Неизвестные capabilities не выдавать за подтверждённую поддержку.

### 6.8. Screen descriptor

```json
{
  "deviceId": "primary",
  "pageSessionId": "01992000-0000-7000-8000-000000000003",
  "viewport": {
    "cssWidth": 1920,
    "cssHeight": 1080,
    "devicePixelRatio": 1
  },
  "reportedScreen": {
    "width": 1920,
    "height": 1080
  },
  "visibilityState": "visible",
  "userAgent": "diagnostic string",
  "capabilities": {
    "localVideo": true,
    "youTube": "notProbed",
    "remoteAudio": true,
    "youTubeRotation": "disabled"
  }
}
```

1920×1080 здесь — пример, не default устройства.
Источник координат — измеренный viewport контейнера, а не только `screen.width`.
DPR и browser-reported screen metrics не доказывают физическое HDMI-разрешение;
его фиксирует аппаратная диагностика отдельно.

При resize, смене display mode или DPR отправлять новый descriptor.

### 6.9. State envelope для admin и screen

```ts
interface StateEnvelope {
  serverInstanceId: string;
  revision: number;
  desired: DesiredRuntimeState;
  observed: ObservedRuntimeState | null;
  screen: ScreenStatus;
  persistence: 'saved' | 'pending' | 'failed';
  cause: {
    commandId: string | null;
    reason: 'startup' | 'command' | 'reconnect' | 'telemetry' | 'internal';
  };
}
```

Только изменение desired увеличивает `revision`. Телеметрия имеет собственный
монотонный `telemetrySequence`, чтобы частые position updates не конфликтовали
с редактированием.

### 6.10. `startup-settings.json`

```json
{
  "schemaVersion": 2,
  "documentRevision": 1,
  "startupMode": "defaults",
  "defaultVisualPresetId": null,
  "defaultAudioPresetId": null,
  "startVisualOnBoot": true,
  "startAudioOnBoot": false,
  "backgroundColor": "#000000",
  "updatedAtUtc": "2026-09-07T06:33:00Z"
}
```

Default source и default preset не дублировать в двух независимых полях.
Чтобы назначить новый источник стартовым, admin сначала сохраняет preset.

`startVisualOnBoot=false` означает не загружать этот стартовый Visual:
фон остаётся пустым. `startAudioOnBoot=false` означает не запускать Audio.
Null preset при true flag — допустимый no-op с пояснением в UI.

В `resumeLast` эти flags не переопределяют восстановленный transport;
UI должен явно показывать, что presets и flags используются только в defaults
или при fallback из невалидного resumeLast.

### 6.11. `runtime-state.json`

```json
{
  "schemaVersion": 2,
  "documentRevision": 8,
  "desiredRevisionAtSave": 42,
  "desired": {
    "visual": {
      "source": null,
      "visible": true,
      "transform": {
        "x": 0,
        "y": 0,
        "width": 640,
        "height": 360,
        "scale": 1,
        "rotation": 0,
        "opacity": 1,
        "objectFit": "contain"
      },
      "playback": {
        "loop": true,
        "playbackRate": 1,
        "muted": true,
        "volume": 70
      },
      "transport": "stopped",
      "playbackGeneration": 0,
      "startPositionSeconds": 0,
      "startPlaylistIndex": null
    },
    "audio": {
      "source": null,
      "playback": {
        "loop": false,
        "muted": false,
        "volume": 50
      },
      "transport": "stopped",
      "playbackGeneration": 0,
      "startPositionSeconds": 0
    },
    "background": { "color": "#000000" }
  },
  "checkpoints": {
    "visual": null,
    "audio": null
  },
  "updatedAtUtc": "2026-09-07T06:33:00Z"
}
```

Это пример пустого runtime с полными channel objects. Размер 640×360 относится
только к начальному прямоугольнику редактора, не к разрешению экрана.
И на диске, и в сетевых DTO channel object присутствует; пустым бывает его source.

Checkpoint содержит sourceFingerprint, playbackGeneration, positionSeconds,
durationSeconds при наличии, ended, playlistIndex/currentVideoId при необходимости
и capturedAtUtc. Для нового source, explicit seek или stop прежний checkpoint
инвалидируется. Play после ended создаёт новую generation с позицией 0;
ended восстанавливается также из checkpoint, а не только из текущего DOM.

Fingerprint вычисляется из нормализованного source. Для remote URL использовать
digest, чтобы не копировать секретный query string в диагностические идентификаторы.
Browser-reported fingerprint сверять с актуальным desired source.

ServerInstanceId и connected=true не восстанавливать с диска как актуальные факты.

Писать meaningful changes с debounce 500–1000 мс, финал drag — немедленно,
checkpoints — не чаще раза в 10 секунд, а также при pause/stop.
На graceful shutdown выполнить bounded flush. Не писать файл на каждом `timeupdate`.

### 6.12. Библиотеки

Оба library-документа имеют `items[]`. Общая запись:

```json
{
  "id": "01992000-0000-7000-8000-000000000001",
  "displayName": "Fire loop",
  "fileName": "01992000-0000-7000-8000-000000000001.mp4",
  "contentType": "video/mp4",
  "sizeBytes": 12345678,
  "durationSeconds": null,
  "width": null,
  "height": null,
  "videoCodec": null,
  "audioCodec": null,
  "sha256": null,
  "availability": "available",
  "createdAtUtc": "2026-09-07T06:33:00Z"
}
```

Audio использует тот же базовый формат без обязательных video-полей.
Metadata probe может использовать `ffprobe`, если он установлен; это не
автотранскодирование. Если probe отсутствует, duration/codecs могут оставаться null.

Состояние browser compatibility хранить отдельно от наличия файла:
успешная загрузка на диск не равна доказанной воспроизводимости.

### 6.13. Visual presets

```json
{
  "id": "01992000-0000-7000-8000-000000000004",
  "name": "Video 100 20 33deg",
  "source": {
    "kind": "localVideo",
    "assetId": "01992000-0000-7000-8000-000000000001"
  },
  "visible": true,
  "transform": {
    "x": 100,
    "y": 20,
    "width": 800,
    "height": 450,
    "scale": 1,
    "rotation": 33,
    "opacity": 1,
    "objectFit": "contain"
  },
  "playback": {
    "loop": true,
    "playbackRate": 1,
    "muted": true,
    "volume": 70
  },
  "initialPositionSeconds": 0,
  "referenceViewport": {
    "cssWidth": 1920,
    "cssHeight": 1080
  },
  "createdAtUtc": "2026-09-07T06:33:00Z",
  "updatedAtUtc": "2026-09-07T06:33:00Z"
}
```

Preset не хранит currentTime, pageSessionId, observed status, generation или
текущее desired revision. Применение preset создаёт новую generation.

`referenceViewport` может быть null, пока экран ни разу не подключался.
Не записывать временный размер admin preview как измерение Pi.

При другом размере экрана не масштабировать preset молча.
По умолчанию сохранить CSS-координаты и показать предупреждение. Admin может
явно выбрать «Адаптировать к экрану»; для YouTube повторно проверить геометрию.

### 6.14. Audio presets

```json
{
  "id": "01992000-0000-7000-8000-000000000005",
  "name": "Background track",
  "source": {
    "kind": "localFile",
    "assetId": "01992000-0000-7000-8000-000000000002"
  },
  "playback": {
    "loop": true,
    "muted": false,
    "volume": 50
  },
  "initialPositionSeconds": 0,
  "createdAtUtc": "2026-09-07T06:33:00Z",
  "updatedAtUtc": "2026-09-07T06:33:00Z"
}
```

Для live remoteAudioUrl initialPositionSeconds=0 и loop=false.
Настройки видео и Audio сохраняются отдельными preset-документами.

### 6.15. Атомарная запись и восстановление

Для одного JSON:

1. Взять per-document async lock на всю read-modify-write операцию.
2. Сериализовать новый документ в уникальный temporary file в том же каталоге.
3. Flush, проверить успешное завершение записи.
4. Сохранить последнюю валидную версию в `.bak`.
5. Заменить основной файл через механизм atomic replace/rename,
   проверенный для целевой ОС и файловой системы.
6. Освободить lock и сообщить результат.

Атомарная замена одного файла не является транзакцией между библиотекой,
preset и physical media. Она также не даёт абсолютной гарантии сохранности
при внезапном отключении питания. Это проверять recovery-тестами.

При чтении повреждённого JSON попробовать валидный `.bak`, сохранить повреждённый
оригинал под диагностическим именем и показать warning. Не делать silent reset
всей библиотеки.

### 6.16. Удаление и согласованность

Default delete отклоняется с `409 assetInUse`, если asset выбран сейчас,
используется preset или через preset назначен на startup.
Ответ содержит список ссылок. Пользователь сначала снимает эти ссылки.

Изменения references в preset/startup/runtime и удаление используют общий
DependencyCoordinator. Между проверкой ссылок и фиксацией deletion intent
нельзя разрешить новую ссылку на удаляемый asset. Asset с pending deletion
недоступен для выбора. Порядок блокировок единый: dependency, затем runtime/file;
не удерживать runtime lock во время долгого I/O.

После проверки: записать устойчивый deletion intent, исключить запись из активной
библиотеки, удалить/переместить physical file в trash, завершить intent.
На старте завершать незаконченные операции. Не уничтожать media до фиксации
намерения и проверки ссылок.

Orphan-файлы не удалять автоматически. Показывать отдельным diagnostic warning.

---

## 7. Структура backend-проекта

```text
PiPlayer.sln
global.json
Directory.Build.props
src/
  PiPlayer.Server/
    Program.cs
    PiPlayer.Server.csproj
    Configuration/
      PiPlayerOptions.cs
    Contracts/
      Sources/
      Commands/
      State/
      Assets/
      Presets/
      Settings/
    Endpoints/
      AuthEndpoints.cs
      SystemEndpoints.cs
      CommandEndpoints.cs
      VideoLibraryEndpoints.cs
      AudioLibraryEndpoints.cs
      PresetEndpoints.cs
      SettingsEndpoints.cs
      MediaEndpoints.cs
    Hubs/
      ScreenHub.cs
    Services/
      Storage/
      Library/
      Playback/
      Sessions/
      Startup/
      Validation/
      Security/
      Diagnostics/
    wwwroot/
  PiPlayer.Web/
tests/
  PiPlayer.Server.Tests/
  PiPlayer.Server.IntegrationTests/
  PiPlayer.Web.Tests/
  PiPlayer.E2E/
scripts/
  publish-linux-arm64.ps1
  deploy.ps1
  preflight.sh
  install-systemd.sh
  configure-kiosk.sh
  start-kiosk.sh
docs/
  hardware-profile.md
  compatibility-report.md
  manual-test-results.md
```

Рекомендуется один backend-проект и один frontend workspace. Не нужны микросервисы,
Redis, message broker или внешняя БД.

C# nullable reference types включены. DTO валидация выполняется на сервере.
Передавать CancellationToken в I/O. Ошибки API возвращать в едином ProblemDetails
формате, без stack trace и абсолютных внутренних путей в публичном ответе.

C# и TypeScript контракты должны иметь одинаковые имена discriminator и полей.
Добавить contract tests на JSON-примерах из документа. Генерация TS из OpenAPI
допустима, но не заменяет проверку SignalR DTO.

---

## 8. Backend services и обязанности

### 8.1. AppDataPathProvider

Разрешает app-relative пути, создаёт недостающие каталоги, проверяет permissions,
свободное место и недопустимые пересечения writable/public директорий.
При недоступном DataPath readiness=false, причина видна в логах и health details.

### 8.2. JsonFileStore<T>

```csharp
public interface IJsonFileStore<T>
{
    Task<T> ReadAsync(CancellationToken ct = default);

    Task<T> UpdateAsync(
        Func<T, T> update,
        long? expectedDocumentRevision,
        CancellationToken ct = default);
}
```

UpdateAsync реализует атомарное read-modify-write. Не выдавать mutable singleton,
который несколько запросов могут менять без блокировки. Для дискретных CRUD
операций success означает, что документ действительно сохранён.

### 8.3. MediaLibraryService

Отвечает за потоковую загрузку, лимиты, проверку контейнера, metadata, listing,
display name, dependencies и controlled deletion.

Загрузка идёт в `.partial`, затем проверка и перенос в окончательное имя.
Только после успешной фиксации library metadata возвращать asset как доступный.
При ошибке убирать незавершённый файл либо фиксировать его для recovery.

### 8.4. SourceValidationService

Проверяет asset kind, существование локального файла, нормализованный YouTube source
и разрешённый remoteAudioUrl. Не делает server-side fetch произвольного URL.
Нормализация URL не доказывает доступность онлайн-контента.

### 8.5. GeometryValidationService

Рассчитывает преобразованные углы, bounding box и итоговые размеры.
Проверяет capability конкретного источника, выход за viewport и безопасные
ресурсные лимиты. Общую математику использовать также в frontend-тестах.

### 8.6. CommandDispatcher и RuntimeStateService

Dispatcher — единственная точка runtime mutations. Все изменения desired state
сериализовать через async queue или короткую критическую секцию.

Не держать state lock во время загрузки файла, чтения сети или ожидания screen ACK.
Reducer должен быть чистой функцией:

```text
(current desired, validated command) -> next desired + effects
```

Effects: публикация snapshot, persistence schedule, cancellation прежней загрузки.
State service отдельно хранит observed reports и их freshness.

### 8.7. ScreenSessionRegistry

Хранит только текущие соединения, deviceId, pageSessionId и lease.

- один активный screen;
- heartbeat каждые 5 секунд;
- lease считается истёкшим после 20 секунд без heartbeat;
- новый pageSessionId не вытесняет активную страницу молча;
- при нормальном disconnect lease освобождается;
- та же page session после reconnect может восстановить lease;
- отклонённая страница повторяет регистрацию с backoff, но не воспроизводит медиа;
- пользовательский restart kiosk сначала завершает прежний browser process.

Клиент отслеживает подтверждённые heartbeat по монотонным локальным часам.
Если подтверждений нет 15 секунд, приостанавливает оба adapter без изменения
пользовательского desired intent. Это происходит до истечения 20-секундной lease
на сервере. Возобновление — только после новой регистрации и snapshot.
Так явно выбирается защита от двойного playback вместо бесконечной работы
отсоединённой страницы. Потеря внешнего интернета сама по себе не мешает
localhost heartbeat.

Локальный `flock` в launcher дополнительно защищает от двух Chromium instances.
Lease не является DRM и не решает проблему злонамеренно модифицированного клиента;
это защита от обычного двойного запуска.

### 8.8. StartupDefaultsService

Вызывается один раз в процессе initialization backend. Возвращает начальный state,
а не рассылает startup commands на каждый ScreenReady.

Для каждого канала отдельно: выбрать preset, проверить references, применить flags,
выставить начальную позицию. При missing preset log warning + диагностический статус.

### 8.9. PresetService

CRUD presets с revision checks, reference validation и capability warnings.
Apply проходит через CommandDispatcher. Одновременно применить один Visual preset
и один Audio preset можно одной командой `applyPresets`, чтобы admin получал
единый desired snapshot.

### 8.10. PersistenceCoordinator

Объединяет частые изменения runtime state, но не откладывает явное сохранение
preset/settings. Хранит статус pending/saved/failed.

При ошибке записи работающий плеер можно оставить играть в памяти, но admin должен
увидеть, что изменения не сохранятся после перезапуска. Не отвечать «сохранено»
после IOException или disk full.

### 8.11. DiagnosticsService

Возвращает версии, uptime, storage status, screen heartbeat, viewport,
статусы источников и последние нормализованные ошибки.

Не возвращает password hash, cookies, токены, полный signed URL или browser profile.
Глубокая аппаратная диагностика выполняется отдельным install-script, а не
произвольной shell-командой из admin.

### 8.12. DependencyCoordinator

Сериализует изменения ссылок между library, presets, startup и выбранными sources.
Не участвует в position telemetry и обычном drag. Предотвращает гонку
«asset прошёл проверку удаления, но другой запрос успел выбрать его».

На старте сопоставляет pending deletion intents, metadata и physical files.
Recovery должен быть идемпотентным и не удалять посторонние orphan-файлы.

---

## 9. SignalR и runtime command contract

### 9.1. Hub и роли

```text
/hubs/screen
```

Роли: Admin и Screen. Роль берётся из аутентифицированной сессии,
а не из доверенного клиентского поля `role`.

Методы:

```text
RegisterAdmin(request)                 -> StateEnvelope
RegisterScreen(request)                -> ScreenRegistrationResult
ScreenReady(request)                   -> StateEnvelope
SubmitCommand(command)                 -> CommandReceipt
ReportPlayback(report)                 -> acknowledgement
ReportViewport(descriptor)             -> acknowledgement
Heartbeat(request)                     -> acknowledgement
RequestState()                         -> StateEnvelope
```

Admin не может вызывать ReportPlayback как Screen.
Screen не может менять библиотеку, startup settings или admin credentials.

### 9.2. Server-to-client events

```text
state.sync              # полный desired snapshot для screen
state.updated           # desired state + persistence для admin
playback.updated        # observed state для admin
screen.statusChanged    # connected / stale / disconnected
command.result          # applied / failed / superseded
library.updated         # metadata revision, без бинарного содержимого
system.warning          # нормализованная ошибка/предупреждение
```

События типизированы. Клиент игнорирует старые revision внутри одного serverInstanceId.
После нового serverInstanceId применяется новая база.

### 9.3. Command envelope

```json
{
  "commandId": "01992000-0000-7000-8000-000000000006",
  "target": "visual",
  "type": "setTransform",
  "expectedRevision": 42,
  "expectedPlaybackGeneration": 4,
  "interactionId": null,
  "clientSequence": null,
  "commit": true,
  "payload": {
    "x": 100,
    "y": 20,
    "width": 800,
    "height": 450,
    "scale": 1,
    "rotation": 33,
    "opacity": 1,
    "objectFit": "contain"
  }
}
```

`expectedRevision` обязателен для дискретных замен источника, применения пресета
и полной формы transform. Конфликт возвращает `stateConflict` и свежий snapshot.

Для realtime drag действует отдельный контракт из 9.6.
`stopAll` не должен блокироваться устаревшим expectedRevision:
это явно авторизованная безусловная остановка.

### 9.4. Команды и семантика

| Target | Type | Поведение |
|---|---|---|
| visual/audio | setSource | Установить source, увеличить generation, startPosition=0; transport определяется явным `autoplay` в payload. |
| visual/audio | play | Из stopped/ended начать с начала с новой generation; из paused продолжить. |
| visual/audio | pause | Сохранить текущую позицию, не менять generation. |
| visual/audio | resume | Продолжить paused source без повторной загрузки. |
| visual/audio | stop | Остановить и сбросить позицию, сохранить source и конфигурацию; увеличить generation. |
| visual/audio | restart | Новая generation, позиция 0, transport=playing. |
| visual/audio | seek | Новая generation с target position; сохранить transport; только при seek capability. |
| visual/audio | setVolume | Изменить volume, не менять muted. |
| visual/audio | setMuted | Изменить muted, не менять volume. |
| visual/audio | setLoop | Для источников, где loop поддерживается. |
| visual | setPlaybackRate | Только доступная скорость adapter. |
| visual | setTransform | Изменить только geometry, без reload media. |
| visual | setVisible | Hide одновременно ставит Visual на pause; show не запускает его автоматически. |
| visual | clear | Убрать source, остановить adapter, оставить фон; Audio не менять. |
| visual | playlistNext/playlistPrevious | Только активный YouTube playlist и свежий observed context. |
| system | applyPresets | Применить переданные preset IDs независимо; отсутствующий ID означает «не менять канал». |
| system | stopAll | Остановить оба канала, сохранить источники и громкости. |
| system | setBackground | Валидированный однотонный фон, без URL и HTML. |

**Hide не является режимом скрытого аудио видео.** Для localVideo пользователь
может вернуть показ и нажать resume. Для YouTube сначала остановить/приостановить
player и лишь после подтверждения скрыть; при сбое уничтожить iframe, а не
оставлять его незаметно звучать.

`play` при visible=false включает видимость и проверяет допустимую геометрию.
При source=null возвращать `sourceNotSelected`.

`setSource` принимает параметр `autoplay` явно; backend не угадывает его по прошлому
состоянию. Настройки geometry/volume/mute сохраняются только в допустимом для нового
source виде. Если прежний transform или playbackRate несовместим, требуется явное
исправление, а не silent fallback. Пока provider capabilities неизвестны,
возможна preliminary validation; окончательная проверка выполняется до play,
и результат отражается в observed state. По умолчанию форма выбора загружает источник paused.
Кнопка «Выбрать и играть» отправляет autoplay=true.

### 9.5. Receipt и фактическое применение

```json
{
  "commandId": "01992000-0000-7000-8000-000000000006",
  "status": "accepted",
  "serverInstanceId": "01992000-0000-7000-8000-000000000007",
  "revision": 43,
  "screenOnline": true,
  "persistence": "pending"
}
```

Возможные итоговые состояния команды:

```text
accepted
applied
failed
superseded
timedOut
```

`accepted` — backend принял desired mutation.
`applied` — screen подтвердил актуальную конфигурацию. Для play дополнительно
нужен observed playing, не только успешный вызов метода adapter.
Для stop нужен фактический stopped/paused-reset результат.

Если команда superseded новым source, её поздняя ошибка не меняет новый плеер.
Не делать автоматический rollback к старому источнику после любой ошибки загрузки.

### 9.6. Realtime drag

Ограничить частоту отправки до 20 updates/sec. Каждый drag имеет interactionId,
clientSequence и исходную playbackGeneration.

Backend допускает один активный drag на Visual, привязанный к admin session.
Первое сообщение проверяет expectedRevision. Следующие используют тот же
interactionId, возрастающий sequence и generation.

Смена source, применение preset или дискретное редактирование geometry
отменяет старый drag. Устаревшие сообщения не могут двигать новый источник.
После 5 секунд без updates interaction истекает.

Промежуточные обновления можно объединять до последнего значения.
Финальный commit обязателен и фиксируется на диске.
Commit использует ту же последовательность, не игнорируется как дубль последнего
preview update. Возвращать итоговый authoritative transform.

### 9.7. Дедупликация

Кэшировать commandId и результат в пределах serverInstanceId,
например последние 1000 команд / 10 минут. Повтор с тем же ID и другим payload
отклонять. После backend restart не обещать exactly-once для старого ID.
Совпавший commandId с прежним payload возвращает сохранённый receipt до проверки
expectedRevision, иначе обычный сетевой retry ошибочно превратится в stateConflict.

Для transport задавать абсолютное намерение `setMuted(true)`, а не `toggleMute`.
Это уменьшает вред от повторной доставки.

### 9.8. Reconnect и freshness

Первый connect и восстановление используют backoff с jitter и верхней границей
30 секунд, без окончательной остановки после нескольких попыток.
В admin показывать reconnecting; в screen продолжать локальное воспроизведение,
если lease и текущий сценарий это допускают.

Heartbeat freshness и SignalR connection — разные показатели.
Connected socket при зависшем renderer не означает, что видео работает.

ReportPlayback отправлять при изменении status сразу, а position — примерно
раз в секунду. Пакеты старой generation/pageSession отклонять.
Телеметрия не должна сохраняться на диск каждую секунду.

---

## 10. REST API

Все изменяющие маршруты требуют Admin, если отдельно не указано Screen.
Использовать JSON ProblemDetails с дополнительным `code`.
Базовый путь — `/api`.

### 10.1. Системные маршруты

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/system/health` | Liveness процесса; без секретов. |
| GET | `/api/system/ready` | Готовность storage и начального runtime state; не зависит от подключённого экрана или интернета. |
| GET | `/api/system/info` | Версии, uptime, hostname, диагностика для Admin. |
| GET | `/api/system/state` | Desired + observed + screen status. |
| GET | `/api/system/diagnostics` | Ограниченный diagnostic snapshot. |
| GET | `/api/system/kiosk-status` | Минимальный read-only статус для локального watchdog; только loopback. |
| POST | `/api/commands` | Тот же CommandEnvelope, что SubmitCommand. |

Не дублировать `/play`, `/pause` и другие runtime mutations в разных контроллерах
с отдельной логикой. Один command endpoint достаточен.

### 10.2. Аутентификация

```http
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/session
GET  /api/auth/csrf
POST /api/screen/session
```

Последний маршрут — только защищённый local bootstrap из `/screen`,
описанный в разделе 18; не общедоступная выдача роли Screen.

### 10.3. Библиотеки

```http
GET    /api/library/videos
POST   /api/library/videos
GET    /api/library/videos/{id}
PATCH  /api/library/videos/{id}
GET    /api/library/videos/{id}/references
DELETE /api/library/videos/{id}

GET    /api/library/audio
POST   /api/library/audio
GET    /api/library/audio/{id}
PATCH  /api/library/audio/{id}
GET    /api/library/audio/{id}/references
DELETE /api/library/audio/{id}
```

Upload — multipart/form-data с `file` и опциональным `displayName`.
Одновременно один media file на запрос. UI может последовательно загружать несколько.
Response: 201 + созданный asset + относительный media URL + library revision.

Rename меняет только displayName. Physical filename остаётся прежним.

### 10.4. Presets

```http
GET    /api/presets/visual
POST   /api/presets/visual
GET    /api/presets/visual/{id}
PUT    /api/presets/visual/{id}
DELETE /api/presets/visual/{id}

GET    /api/presets/audio
POST   /api/presets/audio
GET    /api/presets/audio/{id}
PUT    /api/presets/audio/{id}
DELETE /api/presets/audio/{id}
```

Apply выполняется runtime-командой `applyPresets`.
Delete preset, назначенного на startup, возвращает 409 с объяснением зависимости.

Для PUT/DELETE использовать If-Match с document revision либо явно типизированное
expectedDocumentRevision. Выбрать один вариант и применять единообразно;
для этой реализации принять `If-Match: "<revision>"`.

### 10.5. Настройки

```http
GET /api/settings/startup
PUT /api/settings/startup
```

PUT содержит всю модель 6.10 без server-managed timestamps/revision.
Сохранение не меняет уже работающий экран.
В UI отдельная кнопка «Применить стартовые пресеты сейчас» отправляет runtime command.

### 10.6. Проверка источника

```http
POST /api/sources/normalize
```

Примеры входа:

```json
{
  "target": "visual",
  "input": "https://www.youtube.com/watch?v=M7lc1UVf-VE"
}
```

```json
{
  "target": "audio",
  "input": "https://media.example.com/background.mp3",
  "streamMode": "file"
}
```

Response содержит normalized source и статические warnings.
Никакого server-side скачивания или гарантии playback.
Отдельная кнопка «Проверить на Pi» — явное действие воспроизведения выбранного канала,
а не незаметная фоновая подмена текущей музыки.

### 10.7. Ошибки и коды

```text
400 invalidCommand / invalidSource / invalidTransform
401 authenticationRequired
403 forbidden / screenBootstrapDenied
404 assetNotFound / presetNotFound
409 stateConflict / assetInUse / screenAlreadyConnected
413 uploadTooLarge
415 unsupportedMediaType
422 capabilityNotSupported / youtubeGeometryInvalid
429 rateLimited
503 storageUnavailable / screenUnavailableForOperation
507 insufficientStorage
```

Ответы fetch/API никогда не перенаправлять на HTML login page с кодом 200.
Ошибки upload должны быть читаемы admin, включая превышение framework-level limit.

---

## 11. Безопасная раздача медиа

### 11.1. Маршруты

```http
GET  /media/videos/{assetId}
HEAD /media/videos/{assetId}
GET  /media/audio/{assetId}
HEAD /media/audio/{assetId}
```

AssetId разрешается через library metadata, а не превращается в произвольный путь.
Доступ — авторизованный Admin или Screen. Если выбран явно небезопасный trusted-LAN
режим, это должно быть отдельной настройкой, не случайным обходом middleware.

### 11.2. Потоковая передача

Обязательны корректные Content-Type, Content-Length, byte ranges и ответы
206 / 416. Проверить seek, повторное начало и воспроизведение большого файла
без полной загрузки в память backend.

Не применять response compression к уже сжатым видео и аудио.
Файлы с immutable ID можно кэшировать, но JSON state и index.html не должны
застревать в устаревшем application cache.

### 11.3. Отделение SPA fallback

`/screen` и `/admin` могут возвращать Angular index.html.
Неизвестный `/api/...` или `/media/...` обязан возвращать соответствующий 404,
а не index.html. Иначе media element получит HTML под видом видео.

### 11.4. Работа с файловой системой

Canonical path должен оставаться внутри своего media root.
Не следовать неожиданным symlink за пределы разрешённой директории.
DisplayName безопасно выводить как текст; не использовать innerHTML.

---

## 12. Angular workspace и клиентские компоненты

### 12.1. Структура

```text
src/app/
  core/
    api/
    auth/
    signalr/
    contracts/
    state/
    errors/
  admin/
    dashboard/
    visual-editor/
    audio-controls/
    libraries/
    presets/
    startup-settings/
    diagnostics/
  screen/
    screen-shell/
    visual-renderer/
    audio-renderer/
    adapters/
      local-video.adapter.ts
      youtube.adapter.ts
      html-audio.adapter.ts
    reconciliation/
    telemetry/
  shared/
    geometry/
    validation/
    controls/
```

Маршруты: `/admin`, `/screen`, root redirect -> `/admin`.
В production frontend отдаёт ASP.NET Core; Angular dev server нужен только
для разработки.

### 12.2. Adapter abstraction

```ts
interface PlaybackCapabilities {
  canSeek: boolean;
  canLoop: boolean;
  canSetVolume: boolean;
  canMute: boolean;
  availablePlaybackRates: number[];
  canRotate: boolean;
  rotationStatus: 'supported' | 'experimental' | 'disabled';
  canSetOpacity: boolean;
  isLive: boolean;
}

interface PlayerAdapter {
  load(source: unknown, context: LoadContext): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  dispose(): Promise<void>;
}
```

`unknown` в этом обзорном интерфейсе заменить на generic либо discriminated source
в рабочем коде. Не ослаблять весь проект до any.

Параметры loop и rate реализовать отдельными capability-aware методами.
YouTube void API преобразуется в асинхронный результат через события и timeout,
а не через немедленный `Promise.resolve()` как доказательство playback.

### 12.3. Lifecycle

Только `/screen` создаёт production adapters.
При смене source старый load отменяется через token/generation,
старый adapter освобождает listeners и media resources.

Не создавать новый `<video>` при каждом x/y change.
Не вызывать `loadVideoById` при смене volume.
Не загружать YouTube script на admin и при локальном сценарии без необходимости.

### 12.4. Frontend quality

Strict TypeScript, typed reactive forms, доступные labels, keyboard shortcuts
в admin по желанию. Production `/screen` не зависит от локального keyboard focus.

Уничтожение route должно снимать subscriptions/timers. SignalR connection
управляется одним сервисом на приложение, не создаётся заново в каждом component.


---

## 13. Angular admin UI

### 13.1. Основные разделы

В MVP достаточно одной страницы с вкладками:

```text
Dashboard
Visual
Audio
Video library
Audio library
Presets
Startup
Diagnostics
```

Две главные области управления — Visual и Audio — должны быть доступны без
постоянного переключения вкладок. Состояние соединения и Stop all видны всегда.

### 13.2. Dashboard

Показывать:

- backend online, screen online/stale/offline;
- текущий source обоих каналов;
- requested transport и observed status;
- фактическую позицию, duration либо LIVE;
- volume/mute каждого канала;
- последний playback error;
- pending/failed persistence;
- действующий startupMode и назначенные presets.

До первого screen report показывать «не подтверждено», а не подставлять playing.

### 13.3. Visual control

Выбор source: Local video / YouTube video / YouTube playlist.

Контролы:

```text
Load paused / Play selected
Play / Pause / Resume / Stop / Restart
Seek, когда поддерживается
Visible
Loop
Muted
Volume
Playback rate
X / Y
Width / Height
Lock aspect ratio
Scale
Rotation
Opacity
Object fit
Fit to screen / Center / Reset transform
Save as preset / Apply preset
Clear screen
```

Disabled control сопровождается причиной, а не исчезает без объяснения.
Например, opacity для YouTube фиксирована, rotation помечена experimental/disabled,
seek для live audio недоступен.

`Lock aspect ratio` — настройка редактора, не отдельный transform в runtime.
Она определяет вычисление width/height при ручном resize.
Масштаб и размеры не должны одновременно «компенсировать» друг друга.

### 13.4. Preview

Preview — масштабированная DOM-схема viewport Pi:

```text
previewScale = min(availableWidth / screenWidth,
                   availableHeight / screenHeight)
```

Здесь previewScale не имеет отношения к Visual.transform.scale.
Координаты drag переводятся обратно в screen CSS px делением на previewScale.
При resize повёрнутого слоя использовать обратное преобразование, а не обычное
прибавление mouse delta к width/height.

Обязательно показать фон, границы экрана, точку привязки, повернутый контур слоя,
название источника и текущие размеры. Видео-preview в admin опционален и только
muted; он не является точной трансляцией кадра Pi.

YouTube iframe в admin для preview не создавать. Это предотвращает второй
YouTube autoplay, лишний звук и смешение admin с реальным screen.

При screen offline использовать последнее известное разрешение и пометку stale.
До первого подключения — явно «размер экрана неизвестен», с временной схемой,
но без записи выдуманного 1920×1080 как реальных параметров.

### 13.5. Visual geometry UX

Для x/y и rotation нужны числовые поля, а не только drag.
Пользователь должен иметь возможность точно ввести `100`, `20`, `33`.

Подпись x/y: «Положение точки привязки до поворота».
Дополнительно показывать вычисленные границы после поворота.
Команда Fit для localVideo может менять scale/position, но делает это явно.

При изменении display resolution показать предупреждение о presets.
Для YouTube недопустимую геометрию нельзя автоматически применить с autoplay.

### 13.6. Audio control

Выбор Local file / Direct audio URL. Контролы play, pause, resume, stop, restart,
volume, mute, loop и seek по capabilities.

Для remote URL добавить поле streamMode и пояснение «прямая ссылка на аудио,
не страница музыкального сервиса». Отдельно показать ошибки загрузки,
недоступность, необходимость авторизации и отсутствие seek.

Установка новой музыки никогда не вызывает stop YouTube.

### 13.7. Библиотеки

Плоские списки без folder UI. Колонки: название, тип, размер, duration при наличии,
доступность, дата загрузки. Для видео — разрешение/codec, если известны.

Upload показывает progress и отмену. После отмены partial file должен быть удалён.
При `assetInUse` показать конкретные presets/каналы, которые нужно отключить,
а не абстрактный «не удалось удалить».

Удаление требует подтверждения с именем файла. Rename не требует повторной загрузки.

### 13.8. Presets и startup

Save preset сохраняет конфигурацию, не observed currentTime.
Название редактируется пользователем; одинаковые названия допускаются,
идентичность задаётся ID.

Apply имеет явный выбор «Применить и играть» / «Применить на паузе».
Если применяется только Visual preset, Audio не меняется.

Startup UI содержит startupMode, независимые preset selectors и flags.
Для defaults показывать четыре валидные комбинации:
ничего / только Visual / только Audio / оба.
Missing reference подсвечивается и не маскируется пустой строкой.

### 13.9. Подтверждения и ошибки

Optimistic UI допустим для перемещения, но должен сверяться с authoritative state.
При конфликте дискретной формы загрузить свежие значения и предложить повторное
осознанное применение; не перетирать чужое изменение автоматически.

Autoplay warning показывается в admin. Просьба «нажмите Play на экране Pi»
не является штатным решением для устройства без клавиатуры.

---

## 14. `/screen`: рендеринг и media lifecycle

### 14.1. Оболочка

```html
<div class="screen-root">
  <div class="visual-layer">
    <!-- Either local video OR a YouTube container -->
  </div>
  <audio class="background-audio"></audio>
</div>
```

В `.visual-layer` существует только один активный media adapter.
Audio элемент независим.

Screen имеет однотонный фон, без scrollbars, toolbars приложения,
отладочных баннеров и локальных кнопок. Ошибки сообщаются в admin.
В dev mode статус можно показывать только там, где он не перекрывает YouTube.

### 14.2. CSS-геометрия

```css
html,
body,
app-root {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.screen-root {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--background-color, #000);
}

.visual-layer {
  position: absolute;
  left: var(--x);
  top: var(--y);
  width: var(--width);
  height: var(--height);
  transform-origin: 0 0;
  transform: rotate(var(--rotation)) scale(var(--scale));
  opacity: var(--opacity);
}

.visual-layer video,
.visual-layer iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
```

Frontend задаёт размерные CSS variables с `px`, rotation с `deg`, scale как число.
Не конкатенировать непроверенные пользовательские строки в CSS.

Для localVideo задавать object-fit. Для YouTube не использовать clipping,
маски или opacity ниже 1. Отключённые возможности блокируются ещё до рендера.

### 14.3. Математика углов

Для локальной точки `(u, v)` внутри исходного rectangle:

```text
screenX = x + scale * (u * cos(angle) - v * sin(angle))
screenY = y + scale * (u * sin(angle) + v * cos(angle))
```

Проверить четыре угла `(0,0)`, `(width,0)`, `(0,height)`, `(width,height)`.
Из min/max получить axis-aligned bounding box.

Эта формула используется для preview, Fit, warnings и tests.
Округлять только отображение в UI, не накопленные координаты после каждого drag.

### 14.4. LocalVideoAdapter

Поддерживает source load, play/pause/stop, seek, loop, mute, volume,
допустимые playback rates и transform через внешний контейнер.

Сначала применить muted/volume, затем запрашивать play. Обрабатывать Promise
от `play()` и события media element, включая loading, playing, waiting, pause,
ended и error. Состояние плеера определяется событиями, не последним кликом. [R5][R10]

Для stop — pause и reset позиции. Кадр первого момента можно оставить видимым;
Clear убирает слой полностью. Нельзя гарантировать одинаковый poster для всех
провайдеров, поэтому UI различает Stop и Clear.

### 14.5. Reconciliation

Для каждого snapshot:

1. Проверить serverInstanceId/revision.
2. Сравнить source identity и playbackGeneration.
3. Если source изменился — отменить прежний load, остановить старый adapter,
   создать/загрузить нужный.
4. Если source прежний, но generation новая — выполнить явный seek/restart/reset.
5. Если поменялись только transform/volume/mute — изменить их без reload.
6. Проверить visibility/capabilities.
7. Применить transport после готовности media.
8. Отправить observed report с контекстом актуальной generation.

Все async callbacks обязаны проверять свой load token, актуальный transport
и visibility перед изменением state или запуском playback.
Сценарий «выбрать A, затем B, и A догрузился позже» должен закончиться B.

### 14.6. Ended, loop и checkpoints

Если finite source закончился без loop, observed=ended.
Backend переводит соответствующий desired transport в paused внутренним событием,
не меняя source и не обнуляя checkpoint. Следующий Play стартует с начала.

Не реагировать на ended от старой generation.
Для local loop допустим штатный media loop; бесшовность на любом файле не обещать.

При page reload положение берётся из checkpoint только для того же источника
и generation. При обычном reconnect позицию работающего media element не трогать.

### 14.7. Browser visibility и зависания

Если YouTube-страница скрыта, останавливать его playback; не продолжать скрытый
YouTube как Audio. Возобновление возможно только после восстановления видимости
и проверки действующего desired state.

Не перезагружать Chromium из-за любого buffering: внешний источник может быть
временно недоступен. Watchdog должен отличать отсутствие heartbeat,
зависание интерфейса и media error.

Web app не гарантирует физическое включение монитора и слышимость динамиков.
OS/display power management и аудиовыход проверяются установщиком отдельно.

---

## 15. YouTube adapter

### 15.1. Поддерживаемые URL

```text
https://www.youtube.com/watch?v=<videoId>
https://youtu.be/<videoId>
https://www.youtube.com/embed/<videoId>
https://www.youtube.com/shorts/<videoId>
https://www.youtube.com/playlist?list=<playlistId>
https://www.youtube.com/watch?v=<videoId>&list=<playlistId>
```

При наличии videoId и playlistId default interpretation — playlist с
initialVideoId. UI разрешает явно выбрать «только видео» до нормализации.

Точное сравнение hostname, а не `Contains("youtube.com")`.
Разрешить нужные известные hosts, например youtube.com, www.youtube.com,
m.youtube.com, youtu.be. Не принимать youtube.com.example.org.

Video ID проверять на ожидаемый формат. Playlist ID не ограничивать одним
префиксом `PL`, но ограничить длину и допустимые символы.
Успешный parse не доказывает существование playlist.

YouTube Music URL не выдавать за direct audio URL. Сообщать, что в MVP поддержан
обычный встроенный YouTube Visual, а не неофициальный YouTube Music API.

### 15.2. Загрузка API

Использовать singleton loader YouTube IFrame API с timeout и безопасным повтором.
При ошибке загрузки script сообщать providerUnavailable; другие каналы продолжают
работу.

Плеер инициализируется только в активном Visual container.
Никакого доступа к внутреннему DOM cross-origin iframe или извлечения media URL.

### 15.3. Параметры embed

Указать `enablejsapi=1`, корректный `origin=window.location.origin`
и разрешение autoplay для iframe. Не использовать deprecated параметры
как обещание скрыть branding, рекламу или related content.
Поведение loop для одиночного видео и playlist реализовать согласно параметрам
и проверить отдельно. [R3][R4]

`Referrer-Policy` не должна подавлять необходимый Referer.
Для обычной browser-страницы использовать `strict-origin-when-cross-origin`
и проверить реальное воспроизведение с localhost origin. Не подставлять
выдуманную идентичность приложения и не обещать, что origin устраняет все ошибки. [R1]

### 15.4. Provider-specific controls

Возможности скорости получать у текущего player; после запроса подтверждать
фактическое изменение событием. Не показывать произвольное значение 1.7,
если provider его не поддерживает.

Для playlist нужны next/previous, observed currentVideoId и playlistIndex.
UI не обязан отображать весь удалённый playlist: получение и кеширование полного
каталога через YouTube Data API не входит в MVP.

Применение startPlaylistIndex/checkpoint выполняется только после готовности
playlist. Если сохранённый элемент больше недоступен, показать warning
и использовать доступный стартовый элемент, не создавая бесконечный retry loop.

### 15.5. Ошибки и autoplay

Обработать `onError`, `onStateChange`, `onReady`, `onAutoplayBlocked`
и изменение playback rate. Нормализовать provider codes:

```text
2       invalid provider parameters
5       HTML5 player failure
100     unavailable/private/removed video
101/150 embedding not allowed
153     missing Referer or equivalent client identification
```

Не заменять смысл error 153 общей фразой «автор запретил встраивание». [R3]

При autoplayBlocked статус blocked; в admin указывается конкретная проблема.
Кнопка на Windows не является локальным user activation в Chromium на Pi.
Повторно послать play можно, но это не гарантия снятия ограничения. [R5]

### 15.6. Rotation capability gate

Проверка экспериментального поворота включает:

- весь viewport iframe остаётся видимым;
- controls и branding не скрыты и не перекрыты;
- рассчитанная геометрия соответствует фактической;
- muted/unmuted, pause/resume и resize работают;
- приемлемая производительность на целевом Pi;
- отдельно оценено соответствие актуальным требованиям YouTube.

Результат записывается в compatibility-report.
Без этой проверки `canRotate=false` для YouTube, независимо от того,
работает ли localVideo rotation.

Не заявлять, что функциональность «любое YouTube-видео под любым углом»
безусловно достигнута. Обязательность пользователя сохраняется как отдельная
проверяемая цель, а не незаметно заменяется фиксированным плеером справа снизу.

### 15.7. Внешние ограничения

Недоступное, приватное, регионально ограниченное видео, требование авторизации,
cookie/consent экран или изменение поведения платформы не обходятся скачиванием.
Показывать ясную ошибку в admin. Для полностью автономной приёмки использовать
согласованный набор доступных embed-роликов и чистый browser profile.

---

## 16. Локальная и удалённая музыка

### 16.1. Local audio

Минимальные кандидаты расширений:

```text
.mp3
.wav
.ogg
.m4a
.flac
```

Приёмка определяет поддержанные codec/container combinations на target Chromium.
При неизвестной совместимости разрешённый container можно сохранить в библиотеку,
но playback failure должен быть понятен. Приложение не конвертирует файл автоматически.

Прямое управление `<audio>`: play/pause, stop/reset, seek при доступности,
volume 0..100 с преобразованием в 0..1, muted и loop. [R10]

### 16.2. Remote audio

MVP поддерживает только прямой HTTP(S) audio source, который целевой browser
может воспроизвести без специальных авторизационных заголовков и DRM.

Не поддерживаются в MVP:

```text
HTML pages with embedded players
Spotify / Apple Music service pages
YouTube or YouTube Music as hidden audio
DRM sources
arbitrary cookies or Authorization-header forwarding
automatic extraction of media links from pages
HLS/DASH integration through additional streaming libraries
M3U/PLS playlist parsing
```

Сам по себе URL без расширения не является ошибкой: radio endpoint может не иметь
`.mp3`. Фактическая проверка выполняется media adapter.

### 16.3. Поток данных

Remote source загружает Chromium на Pi напрямую.
Backend хранит настройки и нормализует URL, но не выступает downloader/proxy.
Не добавлять server-side HEAD/GET для произвольных адресов без отдельной
проработки SSRF, redirects и ограничений размера.

По умолчанию принимать только http/https, без userinfo в URL.
`file:`, `javascript:`, `data:`, UNC-пути и команды shell отклонять.

В конфигурации предусмотреть необязательный allowlist remote hosts.
При отсутствии allowlist ввод разрешён только Admin; README предупреждает,
что browser будет обращаться к адресу из сети Pi.
URL validation не является гарантированной сетевой изоляцией от DNS rebinding.

### 16.4. CORS и режим воспроизведения

Не устанавливать `crossOrigin="anonymous"` без необходимости и не подключать
Web Audio analyser ради обычного playback.
Не считать отсутствие CORS-заголовков доказательством, что любой прямой `<audio>`
невоспроизводим: проверять фактическое browser behavior.
Неподдержанные форматы и ограничения доставки показывать как ошибки источника. [R10]

При HTTPS-развёртывании отдельно проверить HTTP audio sources и mixed-content
поведение; не отключать browser security для обхода ограничений.

### 16.5. File и live

`streamMode=file`: seek/loop доступны, только когда их подтверждает media.
`streamMode=live`: duration отображается LIVE, seek и loop отключены.
`auto`: adapter определяет доступные возможности и сообщает их admin.

Pause live source не обещает продолжение с той же секунды.
Resume может вернуться к live edge. Stop очищает активную сетевую загрузку.
Restart для live означает повторное подключение, не перемотку.

### 16.6. Retry

При временной network error разрешены попытки с задержками 1, 2, 5, 10, 30 секунд
с последующим ограниченным повтором до 2 минут. После — error и ручной Retry.
Это проектные значения, вынести в config.

Перед каждой попыткой проверять, что source/generation всё ещё актуальны
и desired transport=playing. User Stop немедленно отменяет retries.

Не повторять автоматически заведомо запрещённые schemes, invalid URL,
auth-required/unsupported source и autoplayBlocked.

### 16.7. Конфиденциальность URL

Query string может содержать временный токен. Не включать полный URL в logs
и diagnostic exports. Хранение source URL в локальном preset не означает
безопасного хранения секрета: права на `data` должны это учитывать.

---

## 17. Валидация, лимиты и устойчивость

### 17.1. Числовые значения

Отклонять NaN, Infinity, строки вместо чисел и неожиданные поля.
Для явных API mutations предпочитать 422 с причиной, а не silent clamp.
Во время drag UI может ограничивать значение заранее; сервер всё равно валидирует.

Предлагаемые initial limits:

```text
x/y:                 -10000 .. 10000 CSS px
width/height:        1 .. 4096
scale:               0.01 .. 8
rotation:            любое конечное число, нормализация в [0, 360)
opacity:             0 .. 1
volume:              0 .. 100
local playbackRate:  0.25 .. 4, с подтверждением target browser
displayName:         1 .. 200 символов
remote URL:          до 4096 символов
```

Одновременно ограничить effective width/height и rendered area после scale.
Стартовая policy: maxEffectiveDimension=4096, maxRenderedArea=8294400.
Это safety limits приложения, не обещание, что Pi способен плавно играть 4K.

Ресурсные лимиты могут быть уменьшены hardware profile без изменения формата API.

### 17.2. Source-specific geometry

LocalVideo может частично выходить за границы и обрезаться экраном.
Opacity=0 для local допустима, но интерфейс предупреждает, если при этом остаётся
слышимым его звук.

YouTube проходит отдельную проверку из раздела 2.
Если фактический viewport ещё неизвестен, backend проверяет формат и статические
лимиты, но помечает geometry как ожидающую проверки screen. Readiness backend
не ждёт дисплея. Перед реальным play screen повторяет provider-specific validation
на измеренном viewport; при неуспехе сообщает blocked/youtubeGeometryInvalid,
а не запускает off-screen player.

Если source меняется с local на YouTube, ранее допустимая геометрия может стать
невалидной. Не сохранять незаметно 10×10 или отрицательный off-screen YouTube.
Предложить явное применение безопасного Fit.

### 17.3. Upload limits

```json
{
  "PiPlayer": {
    "MaxVideoUploadBytes": 524288000,
    "MaxAudioUploadBytes": 104857600,
    "MinFreeDiskBytes": 1073741824,
    "MaxConcurrentUploads": 1
  }
}
```

Размеры соответствуют 500 MiB и 100 MiB. В UI использовать корректные единицы.
Проверять лимит не только по Content-Length, но и по реально прочитанным bytes.

Настроить Kestrel request-body limit и multipart/streaming limits согласованно,
с небольшим запасом на multipart overhead. Одного собственного `MaxVideoUploadBytes`
недостаточно: ASP.NET Core имеет отдельные ограничения загрузок. [R9]

Для больших файлов использовать streaming, не MemoryStream на весь upload.
С отменой запроса останавливать запись и очищать partial.

### 17.4. Проверка формата

Extension и присланный Content-Type недостаточны. Проверять сигнатуру/контейнер,
разрешённый media kind и разумные metadata. При необходимости использовать ffprobe
как ограниченный отдельный процесс с timeout, без shell interpolation.

Файл `.mp4` может содержать неподдержанный codec. Upload validation и playback
compatibility — разные проверки.

### 17.5. Питание, запись и место

Не писать JSON при каждом mousemove/timeupdate.
Disk full не должен повреждать последнее валидное состояние.
Сбой записи файла настроек не должен уничтожать работающий media element.

Логи ротировать либо использовать journald с ограничениями.
Приёмка включает внезапное завершение процесса во время записи и восстановление,
но не требует физически многократно отключать питание без необходимости.

### 17.6. Missing assets

Если файл удалён вручную: пометить asset missing, не удалять все ссылающиеся
presets молча. На playback показать assetMissing и продолжить другой канал.
В UI должна быть возможность удалить/исправить broken preset.

### 17.7. Версии и миграция

При наличии реальных v1 данных выполнить явную backup-first migration:

```text
animation library -> video library
animation presets -> visual presets with localVideo source
local music presets -> audio presets
YouTube music presets -> visual presets
```

Если v1 одновременно задавал animation и YouTube music, оба претендуют на один
Visual. Не выбирать победителя молча: сохранить данные, сообщить migration conflict
и не запускать конфликтующий default до выбора пользователя.

Если старого deployed приложения нет, не разрабатывать сложный migration engine;
достаточно version guard и документированного отказа от silent data overwrite.

---

## 18. Безопасность внутри LAN

### 18.1. Базовая модель

Не открывать приложение в интернет, не добавлять UPnP port forwarding.
Прослушивание `0.0.0.0` означает все интерфейсы, а не автоматически «только LAN».
Установщик должен настроить bind address/firewall для нужной сети.

Backend и kiosk — непривилегированные пользователи.
Пути и команды ОС не принимаются из UI.

### 18.2. Admin authentication

По умолчанию установка включает admin authentication.
Не использовать общий PIN `1234`. Установщик создаёт пароль или принимает
введённый через SSH; хранится salted password hash, не plaintext.

Для same-origin UI использовать HttpOnly session cookie и стандартную
ASP.NET Core authentication/authorization, включая Hub. [R8]
Data Protection keys сохранять в `data/security/data-protection` с ограниченными
правами и стабильным application name, чтобы обычный backend restart не разрушал
валидные сессии без причины.

Cookie: SameSite=Strict, разумный timeout, Secure при HTTPS.
Для LAN HTTP явно документировать отсутствие шифрования: пароль и cookie
не защищены от наблюдателя сети. Не заявлять такую установку эквивалентом HTTPS.

CSRF protection нужна для REST mutations с cookies.
WebSocket/SignalR origin также проверяется: одного CORS для WebSocket недостаточно.
Login имеет rate limit; GET endpoints не выполняют изменения.

Опциональный `TrustedLanWithoutAdminAuth=true` допустим только явно.
Он отключает admin password requirement, но не screen-role protections,
проверку Host/Origin, пути и лимиты upload.

### 18.3. Screen bootstrap без клавиатуры

Выбранная схема MVP — доверие локальному ОС-пользователю через loopback endpoint:

1. `/screen` загружается с настроенного `http://localhost:5000`.
2. Выполняет same-origin JSON POST `/api/screen/session`
   с дополнительным `X-PiPlayer-Client: screen`.
3. Backend проверяет реальный RemoteIpAddress=loopback, точный Host,
   разрешённый Origin, JSON Content-Type и указанный header.
4. При успехе выдаёт отдельную HttpOnly Screen cookie.
5. Screen cookie даёт только регистрацию/telemetry/media read, не Admin.
6. Cross-origin запросы и LAN-клиенты получить Screen cookie не могут.
7. При истечении Screen cookie клиент повторяет loopback bootstrap автоматически,
   без клавиатуры; transport и source восстанавливаются по актуальному snapshot.
   Не допускать бесконечный retry с просроченной cookie.

Не доверять Forwarded/X-Forwarded-For от произвольного клиента.
В этой схеме reverse proxy для screen bootstrap по умолчанию не используется.

Это не защита от вредоносного локального процесса с доступом к Pi.
Она решает unattended bootstrap и случайный захват screen-роли из LAN.
При более строгой threat model потребуется отдельная device credential схема.

### 18.4. Host, Origin и CSP

AllowedHosts и allowed origins задаются установкой: localhost, фактическое имя
и необходимые IP. Не разрешать произвольный Host и Origin отражением входного
значения.

CSP разрабатывать под реальную Angular production build, локальные media
и необходимые домены YouTube. Разрешения расширять только по проверенным причинам.
Не «чинить» интеграцию флагами `--disable-web-security`, `--no-sandbox`
или отключением всей CSP.

### 18.5. Дополнительные ограничения

Screen не может загружать произвольный shell script.
Admin diagnostics не содержит произвольный command executor.
Выключение/перезагрузка ОС из web UI не входят в MVP; обслуживать по SSH.
Медиа загружаются и используются пользователем с необходимыми правами.


---

## 19. Установка, публикация и kiosk

### 19.1. Обязательная preflight-диагностика

До изменения автозапуска сохранить в `hardware-profile`:

```text
Raspberry Pi model
RAM
OS name/version
user-space architecture
kernel architecture
desktop/compositor/display manager
Chromium executable and version
active display modes and scaling
audio server and selected output
free storage
SSH availability
current app/kiosk installation, if any
```

Базовые диагностические команды:

```bash
cat /etc/os-release
uname -m
getconf LONG_BIT
dpkg --print-architecture
free -h
df -h
command -v chromium || command -v chromium-browser
loginctl list-sessions
```

`dpkg` использовать только на соответствующей системе. При отсутствии команды
вывести «не определено», а не падать без объяснения.
Для compositor смотреть активную графическую сессию: SSH shell сам может быть tty
и не отражать тип desktop session.

Не переустанавливать ОС и не форматировать накопители автоматически.
Сначала определить, что уже установлено и что нужно сохранить.

### 19.2. Reference deployment

Эталон: 64-битный Linux userspace с поддерживаемыми зависимостями .NET 10,
Chromium и автоматически запускаемой графической сессией.

Публикация self-contained для `linux-arm64` включает .NET runtime, но не заменяет
проверку ОС и системных библиотек. Microsoft отдельно различает target runtime
для 64- и 32-битной ОС. [R12]

MVP release artifact — linux-arm64. Если фактическая ОС 32-битная, preflight должен
остановить именно установку несовместимого artifact и объяснить выбор:
отдельная поддержанная сборка или согласованное изменение ОС.
Нельзя запускать ARM64 бинарник только потому, что сам процессор 64-битный.

### 19.3. Build на Windows

Coding agent должен подготовить `publish-linux-arm64.ps1`, который:

1. Проверяет версии SDK, Node и package manager.
2. Выполняет frontend `npm ci`.
3. Запускает frontend tests и production build.
4. Проверяет наличие реального `index.html` в output.
5. Копирует browser build в backend wwwroot.
6. Выполняет backend tests.
7. Публикует self-contained linux-arm64.
8. Копирует install scripts и README.
9. Проверяет отсутствие dev secrets и пользовательского data.
10. Формирует archive, checksums и сведения о версиях.

Пример ключевой команды:

```powershell
dotnet publish src/PiPlayer.Server/PiPlayer.Server.csproj `
  -c Release `
  -r linux-arm64 `
  --self-contained true `
  -p:PublishTrimmed=false `
  -o ./publish/pi-player
```

Angular output path установить явно. Учитывать реальную структуру build output,
а не слепо копировать весь `dist`, если index.html находится в browser subdirectory.

Не включать NativeAOT и trimming в MVP без отдельной проверки сериализации
и SignalR. На Pi не требуются Node.js и Angular CLI для обычного запуска
уже собранного приложения.

### 19.4. Backend systemd unit

Базовый unit, который установщик адаптирует под фактические пути:

```ini
[Unit]
Description=PiPlayer server
After=network.target

[Service]
Type=simple
User=pi-player
Group=pi-player
WorkingDirectory=/opt/pi-player
ExecStart=/opt/pi-player/PiPlayer.Server
Restart=always
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/pi-player/data

[Install]
WantedBy=multi-user.target
```

Listen URL задаётся appsettings или unit override.
При другом DataPath синхронно изменить ReadWritePaths.
External mount — при необходимости добавить корректную mount dependency;
не требовать интернет для локального старта.

Service user создаётся установщиком. `/opt/pi-player/data` существует и доступен
до запуска service. stdout/stderr направляются в journald.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pi-player.service
systemctl status pi-player.service
journalctl -u pi-player.service -n 100 --no-pager
```

В приложении проверяется readiness до открытия browser; успешный запуск процесса
сам по себе не означает, что storage и runtime готовы.

### 19.5. Графическая сессия и autostart

Chromium запускается от пользователя графической сессии, не из root backend unit.
Для Raspberry Pi OS с labwc официальный kiosk-подход использует
`~/.config/labwc/autostart`. [R7]

Пример добавляемой строки:

```bash
/opt/pi-player/scripts/start-kiosk.sh >> "$HOME/.local/state/pi-player/kiosk.log" 2>&1 &
```

Установщик предварительно создаёт log directory, ограничивает размер логов
и не уничтожает существующий autostart. Повторная установка не добавляет
дублирующую строку.

Если обнаружен X11, другой Wayland compositor, Ubuntu Desktop или OS Lite,
не записывать labwc config наугад. Выбрать поддержанный adapter или вывести
точную инструкцию, чего не хватает. OS Lite без GUI не становится kiosk
от одной команды запуска Chromium.

Desktop autologin, отключение screen blanking и выбор аудиовыхода — обязательные
installation tasks, реализуемые для подтверждённого окружения.

### 19.6. Требования к `start-kiosk.sh`

Скрипт должен:

1. Проверить, что запущен внутри графической сессии.
2. Найти фактический Chromium executable.
3. Создать отдельный постоянный browser profile.
4. Захватить `flock` для единственного kiosk launcher.
5. Ожидать `/api/system/ready`, повторяя curl с timeout.
6. Запустить Chromium в foreground/контролируемом child process.
7. При выходе Chromium перезапустить его с задержкой.
8. Обрабатывать завершение launcher и убирать собственный процесс browser.
9. Не вмешиваться в другие Chromium profiles пользователя.
10. Вести ограниченный лог и обеспечивать watchdog из 19.8.

Reference launch arguments:

```bash
chromium \
  --user-data-dir="$HOME/.local/share/pi-player/chromium-profile" \
  --kiosk \
  --no-first-run \
  --noerrdialogs \
  --autoplay-policy=no-user-gesture-required \
  "http://localhost:5000/screen"
```

Это пример запуска, не универсальный установщик для любой ОС.
Путь Chromium и его package confinement проверяются preflight.

### 19.7. Autoplay без локального нажатия

Chrome документирует флаг `--autoplay-policy=no-user-gesture-required`;
его использование в dedicated kiosk profile должно быть проверено на фактически
установленном Chromium. Также возможны поддержанные device policies. [R5]

Не использовать этот флаг в обычном пользовательском browser profile.
Не считать его гарантией доступности YouTube, корректных cookies или audio output.

Обязательная аппаратная проверка после холодного boot:

```text
local muted video
local unmuted video
local audio
YouTube muted
YouTube unmuted
YouTube muted + independent local audio
```

Каждый результат фиксируется отдельно. Ошибка не превращается в
«работает, если нажать на Pi»: отсутствие локального ввода — требование продукта.

### 19.8. Watchdog и восстановление

`start-kiosk.sh` либо связанный user-level watchdog контролирует состояние browser
и heartbeat screen через read-only `/api/system/kiosk-status`.

Этот endpoint доступен только с loopback и разрешённым Host, возвращает только:

```json
{
  "serverReady": true,
  "screenConnected": true,
  "lastHeartbeatAgeSeconds": 2,
  "activePageSessionId": "01992000-0000-7000-8000-000000000003"
}
```

Endpoint не запускает команды ОС. Добавить его в SystemEndpoints и security tests.

Правила watchdog:

- grace period после browser launch — 60 секунд;
- если backend недоступен, не перезапускать browser бесконечно;
- при здоровом backend и отсутствии heartbeat больше 30 секунд повторить проверку;
- после трёх последовательных неудач завершить только собственный kiosk process
  и запустить заново;
- media buffering/error при свежем heartbeat не является зависанием browser;
- ограничить частоту: не более трёх restart за 10 минут, затем cooldown 5 минут;
- после cooldown снова пытаться восстановиться, не требуя клавиатуры;
- новый screen восстанавливает runtime state/checkpoint, не startup defaults.

Supervisor нельзя называть надёжным, пока не проверено, что он отслеживает реальный
Chromium process, а не только краткоживущий shell wrapper пакета.

### 19.9. Display и audio

Зафиксировать browser zoom и OS scaling. Для ожидаемого соответствия 1 CSS px
одному физическому пикселю нужен проверенный режим без дополнительного масштабирования;
по умолчанию приложение обещает координаты в CSS px.

Отключить сон/blanking средствами фактической графической среды.
Не выполнять X11-команды вроде xset в Wayland, предполагая, что они сработают.

Выбрать системный audio sink и проверить после reboot.
Громкость приложения не управляет физической ручкой монитора и не отменяет
системный mute. При отсутствии звука диагностика должна различать эти уровни.

На смену display mode `/screen` отправляет новый viewport.
Reconnect HDMI и отключение/включение монитора входят в hardware tests.

### 19.10. Установка и обновление без клавиатуры

README должен описывать путь с Windows:

```text
SSH access
-> preflight
-> publish
-> upload release to temporary directory
-> create service user and data permissions
-> configure app and admin password
-> install backend service
-> configure graphical autologin/kiosk
-> verify ready/admin/screen
-> reboot
-> run cold-boot acceptance
```

Если SSH ещё не работает, его первоначальная настройка — prerequisite,
а не задача веб-приложения, которое ещё не установлено.

Ручное обновление:

1. Сохранить backup и текущий release identifier.
2. Остановить backend и kiosk на время замены.
3. Заменить только code/build/scripts.
4. Не удалять data и browser profile.
5. Применить проверенные schema migrations.
6. Запустить service и kiosk.
7. Проверить readiness и local playback.
8. При неуспехе вернуть бинарники и совместимый data backup.

Не обещать безопасный rollback старого бинарника поверх уже мигрированной
несовместимой schema.

---

## 20. Этапы реализации

### Phase 0 — feasibility на целевой платформе

**Задачи:** hardware profile; маленький screen prototype; local video под 33°;
video sound + separate audio; YouTube embed; autoplay после запуска kiosk;
YouTube rotation investigation; выбранные codec/container combinations.

**Приёмка:** записаны фактические OS/browser versions и результаты.
При отсутствии Pi создать prototype и manual checklist, но статус hardware
проверок оставить `notRun`. Не тратить весь проект на неподтверждённую основу.

### Phase 1 — репозиторий, контракты, skeleton

**Задачи:** .NET/Angular solution, pinned versions, routes, health/ready,
единообразные DTO, state schema, auth foundation, SignalR connect.

**Приёмка:** сборка воспроизводима; Angular открывается с backend;
unauthorized calls отклоняются; screen и admin различаются.

### Phase 2 — storage и recovery

**Задачи:** paths, JsonFileStore, revision checks, backups,
runtime persistence coordinator, schema guards, disk-full handling.

**Приёмка:** данные создаются рядом с app, concurrent updates не теряются,
повреждённый файл не стирает библиотеку молча.

### Phase 3 — библиотеки и media delivery

**Задачи:** streaming upload, format validation, CRUD metadata,
references, deletion recovery, Range serving, admin upload UI.

**Приёмка:** большой файл не целиком в памяти; cancel очищает partial;
seek работает; in-use asset не удаляется; data/security не доступны по HTTP.

### Phase 4 — command pipeline и local Visual

**Задачи:** dispatcher/reducer, generations, snapshots, adapter lifecycle,
transform editor, drag coalescing, local playback и telemetry.

**Приёмка:** сценарий 100/20/33; pause/volume не перезагружают source;
race A->B корректна; фактический playing отличается от accepted.

### Phase 5 — независимый Audio

**Задачи:** local audio, direct remote audio, volume/mute,
file/live capabilities, cancelable retries.

**Приёмка:** звук Visual и Audio независимы; stop одного не влияет на другой;
URL страницы не выдаётся за поддержанный источник.

### Phase 6 — YouTube Visual

**Задачи:** parser, official adapter, video/playlist playback,
provider events/errors, geometry policy, capability-aware UI,
сохранение результатов rotation investigation.

**Приёмка:** YouTube не живёт в Audio модели, не останавливается при запуске
локальной музыки; его ошибки не блокируют остальную систему.
Experimental rotation не считается passed без соответствующей проверки.

### Phase 7 — presets и startup

**Задачи:** Visual/Audio preset CRUD, atomic applyPresets,
startupMode defaults/resumeLast, independent defaults,
reference validation и explicit migration warnings.

**Приёмка:** четыре комбинации defaults работают; settings save не меняет screen;
ScreenReady не применяет defaults повторно.

### Phase 8 — reconnect и отказоустойчивость

**Задачи:** indefinite retry, screen lease, page session,
checkpoint restore, late callback rejection, observed freshness,
offline desired updates, browser/watchdog integration.

**Приёмка:** disconnect не перематывает видео; reload восстанавливает runtime;
второй screen не создаёт дублирующий звук.

### Phase 9 — установка, hardening, итоговая документация

**Задачи:** publish/deploy/preflight/install scripts, service unit,
compositor adapter, admin credentials, firewall guidance,
cold-boot tests, compatibility report, README.

**Приёмка:** установка на проверенном окружении воспроизводима по README;
после reboot клавиатура не нужна; неподтверждённые hardware/provider возможности
чётко перечислены, а не скрыты.

---

## 21. План тестирования

### 21.1. Unit tests backend

Обязательные группы:

```text
source discriminators and DTO serialization
URL parsing and exact-host validation
geometry and transformed corners
capability validation
state reducer and generation transitions
command deduplication
revision conflicts
startup defaults and resumeLast
asset/preset references
atomic JSON update and backup recovery
path traversal and symlink boundaries
upload byte limits and cancellation
deletion intent recovery
log redaction
```

Тесты state reducer должны доказать, что команда одному каналу не меняет другой.

### 21.2. Frontend tests

```text
preview coordinate conversion
rotated resize mathematics
screen resize and stale viewport
adapter lifecycle / dispose
source A -> source B race
old generation events ignored
play Promise rejected
YouTube error normalization
capability-aware controls
volume/mute independence
reconnect without reload
new page checkpoint restore
admin does not become Screen
```

YouTube SDK подменяется test double; это проверяет интеграционную логику,
но не заменяет реальные provider tests.

### 21.3. Integration tests

Проверить на настоящем ASP.NET test host и временном data root:

1. Login/CSRF, Admin/Screen policies.
2. Upload -> metadata -> GET/HEAD/range -> delete.
3. Unknown media/API path возвращает 404, не Angular HTML.
4. Apply preset проходит тот же dispatcher, что SubmitCommand.
5. Startup state формируется до readiness.
6. RegisterScreen получает текущее состояние.
7. Reconnect не повторяет defaults.
8. Storage failure виден в API/persistence status.
9. Screen bootstrap из LAN/cross-origin запрещён.
10. Kiosk-status endpoint не доступен как административный обход.
11. Missing asset не останавливает независимый канал.
12. Cookies и tokens не попадают в logs.

### 21.4. Hardware/manual acceptance matrix

| ID | Проверка | Ожидаемый результат |
|---|---|---|
| HW-01 | Cold boot без default presets | Backend + fullscreen screen, пустой фон, тишина. |
| HW-02 | Только Visual default | Видео запускается; Audio не запускается. |
| HW-03 | Только Audio default | Музыка запускается, фон остаётся пустым. |
| HW-04 | Оба default | Оба канала стартуют независимо. |
| HW-05 | Local x=100/y=20/rotation=33 | Привязка и геометрия соответствуют контракту. |
| HW-06 | Local video со звуком + local Audio | Слышны оба; mute/volume независимы. |
| HW-07 | YouTube + local Audio | Музыка не останавливает YouTube. |
| HW-08 | Local Visual + remote live Audio | Видео играет, Audio показывает LIVE. |
| HW-09 | Изменить transform во время playback | Нет перезагрузки источника или скачка позиции. |
| HW-10 | Обновить admin | Playback не меняется. |
| HW-11 | Закрыть admin | Pi продолжает работать. |
| HW-12 | Оборвать/вернуть SignalR | Текущее видео не сбрасывается к началу. |
| HW-13 | Reload `/screen` | Текущий runtime восстановлен, defaults не подставлены. |
| HW-14 | Kill Chromium | Launcher/watchdog восстанавливает kiosk. |
| HW-15 | Renderer без heartbeat | Recovery по watchdog, без restart из-за обычного buffering. |
| HW-16 | Restart backend, mode=defaults | Применяются configured defaults один раз. |
| HW-17 | Restart backend, mode=resumeLast | Восстанавливается сохранённый runtime. |
| HW-18 | Нет интернета | Локальные каналы и admin доступны. |
| HW-19 | YouTube embedding forbidden | Понятная provider error, Audio продолжает работать. |
| HW-20 | Remote audio unavailable | Retry по policy, затем error; Visual не затронут. |
| HW-21 | Удаление asset in use | 409 со списком references. |
| HW-22 | Повреждён runtime JSON | Recovery из backup или явный fallback warning. |
| HW-23 | Disk full при записи | Нет ложного «сохранено», старый файл сохранён. |
| HW-24 | Второй `/screen` | Не становится дополнительным активным плеером. |
| HW-25 | HDMI reconnect / смена mode | Новый viewport; нет скрытого дрейфа координат. |
| HW-26 | Длительное воспроизведение | Нет устойчивого роста памяти или частых JSON writes. |
| HW-27 | Cold boot unmuted без interaction | Результат подтверждён для локальных и YouTube источников отдельно. |
| HW-28 | YouTube rotation | Supported/experimental/failed/notRun с конкретным результатом, не автоматический pass. |
| HW-29 | Seek/loop на большом local file | Работают Range requests, файл не загружается целиком в backend RAM. |
| HW-30 | Отключить звук ОС | Admin не утверждает, что программный playing доказывает физическую слышимость. |

### 21.5. Производительность

Начальные цели, а не подтверждённые результаты:

- заметное применение drag в LAN — ориентир до 200 мс при нормальной нагрузке;
- до 20 transform updates/sec без записи JSON на каждый update;
- отсутствие frame drops, заметных пользователю, на согласованном test media profile;
- отсутствие устойчивого роста памяти в двухчасовом playback test;
- загрузка большого файла не должна блокировать control channel;
- local playback не должен зависеть от загрузки YouTube script.

В отчёте указывать model/RAM/OS/browser/resolution/codecs/bitrate/fps.
Нельзя писать «поддерживает 4K» лишь на основании допустимого расширения файла.

### 21.6. Test status

Для каждой аппаратной и внешней проверки использовать:

```text
passed
failed
notRun
blockedByEnvironment
experimental
```

Coding agent не должен превращать «написан тест» в «протестировано на Pi».

---

## 22. Non-goals MVP

Не реализовывать:

- несколько Visual layers, несколько экранов и синхронизацию устройств;
- hidden YouTube audio, media downloading/ripping, обход ограничений embed;
- неофициальный YouTube Music API;
- Spotify/Apple Music integration, DRM, произвольные веб-страницы как источники;
- HLS/DASH engine, local playlists и internet playlist parsing;
- GIF/Lottie/Canvas-анимации вместо видео;
- timeline, video editing, automatic transcoding, chroma key и transitions;
- облако, публичное интернет-управление, accounts для нескольких пользователей;
- SQLite, внешнюю БД, Redis или message broker;
- self-updater, автоматическое форматирование/переустановку ОС;
- произвольный shell executor в admin;
- полноценную прямую трансляцию экрана в preview.

Расширение на несколько видеослоёв потребует нового domain state, presets и
управления ресурсами. Не притворяться, что добавление `[]` к текущей модели
автоматически делает такую функцию готовой.

---

## 23. Ожидаемые результаты работы coding agent

1. Рабочий backend и Angular frontend с `/admin` и `/screen`.
2. Независимые Visual и Audio с согласованными DTO.
3. Local video transforms, playback и звук.
4. YouTube video/playlist через официальный adapter, с честными capabilities.
5. Local audio и direct remote audio с независимыми controls.
6. Flat libraries, streaming uploads, delete/reference safety.
7. File-only persistence, recovery и version guards.
8. Visual/Audio presets, defaults/resumeLast, independent startup.
9. Desired/observed state, command receipts и actual error reporting.
10. Reconnect, page reload recovery, single-screen registration.
11. Production publish artifact и checksums.
12. Обязательные install/kiosk/watchdog scripts для подтверждённого окружения.
13. Automated tests и результаты их выполнения.
14. Hardware/compatibility/manual acceptance reports.
15. README с установкой, использованием, обновлением и диагностикой.
16. Список известных ограничений и непроверенных функций.

В корне репозитория оставить `IMPLEMENTATION-STATUS.md`: completed / partial /
not implemented / not tested, с привязкой к фазам и tests.
Не считать проект готовым только потому, что solution компилируется.

---

## 24. Рекомендуемый порядок работ и Definition of Done

### 24.1. Порядок

```text
1. Hardware/browser feasibility or explicit notRun report.
2. Shared contracts and source/capability model.
3. Backend + Angular skeleton and auth foundation.
4. JSON storage, revisions and recovery.
5. Media libraries and streaming delivery.
6. Command dispatcher, desired/observed state.
7. Local Visual and precise transform editor.
8. Independent local and remote Audio.
9. YouTube Visual adapter and policy/capability gates.
10. Presets and startupMode.
11. Reconnect, page reload, stale event protection.
12. Kiosk installation and watchdog.
13. Integration/manual tests, docs and final status report.
```

Каждая фаза оставляет buildable project. Новые контракты обновляются одновременно
в backend, frontend, JSON examples и tests.

### 24.2. Минимальная готовность продукта

Готовность на целевой Pi означает, что пользователь может через Windows:

```text
загрузить видео
-> установить x=100, y=20, rotation=33
-> включить/выключить его звук
-> независимо запустить музыку
-> сохранить presets
-> назначить startup
-> перезагрузить Pi
-> увидеть тот же настроенный сценарий без клавиатуры
```

Дополнительно проверены YouTube и remote Audio в заявленном объёме,
а их внешние ограничения честно отражены.

Сборка на developer machine без доступа к Pi может быть готова к deployment,
но не называется полностью прошедшей аппаратную приёмку.

### 24.3. Что нельзя считать завершением

```text
Chromium открывается, но ждёт локального клика для звука.
YouTube работает только в маленьком фиксированном углу.
Новая музыка выключает YouTube.
Reconnect применяет default вместо текущего state.
Admin пишет playing сразу после отправки команды.
Изменение x/y пересоздаёт плеер.
Данные хранятся только в localStorage.
Установщик перезаписывает весь data.
YouTube rotation заявлена без проверки.
```

Фиксированное safe YouTube размещение без rotation допустимо только как явно
описанный ограниченный результат, а не как полное выполнение пользовательской
цели о произвольном угле.

---

## 25. Готовая инструкция coding agent

```text
Реализуй PiPlayer по этому документу как единственному актуальному техническому
заданию. Старую модель Animation + Music не переносить без переработки.

Приложение работает на Raspberry Pi с подключённым экраном без локальной
клавиатуры. Windows browser открывает /admin и управляет /screen на Pi.
Backend: .NET 10 / ASP.NET Core. Frontend: Angular. Realtime: SignalR.
Хранение: только JSON и media files рядом с приложением, без БД.

Обязательная доменная модель:
- один Visual: localVideo, youtubeVideo или youtubePlaylist;
- один независимый Audio: localFile или direct remoteAudioUrl;
- звук Visual и Audio имеет независимые volume/mute;
- запуск Audio не останавливает YouTube;
- управление transform не перезагружает media.

Для localVideo обязательно реализуй x/y/width/height/scale/rotation/opacity,
objectFit, loop, speed, play/pause/stop/restart/seek.
Используй точную семантику CSS px и top-left pivot из документа.
Сценарий x=100, y=20, rotation=33 должен проверяться тестами.

YouTube использует только официальный IFrame API. Не скачивай контент,
не извлекай аудио, не скрывай работающий player для фоновой музыки.
Не добавляй фиксированный YouTube угол вместо общего Visual editor.
Соблюдай source-specific geometry/capability validation.
Поворот YouTube — отдельно проверяемая experimental capability, default off;
не заявляй его официально поддержанным или протестированным без основания.

Реализуй:
- streaming upload/list/rename/delete для двух плоских libraries;
- безопасный media serving с Range;
- Visual/Audio presets;
- independent startup presets и defaults/resumeLast;
- startup initialization один раз на процесс backend;
- reconnect -> current runtime snapshot, не повторный startup;
- desired state отдельно от observed playback;
- generation/revision/session guards для устаревших callbacks и команд;
- фактические errors/autoplayBlocked в admin;
- single-screen registration и preview без дополнительного playback;
- atomic JSON writes, debounce, backups и recovery;
- auth, screen bootstrap, path validation и upload limits;
- hardware-aware preflight, publish/install scripts;
- systemd backend, graphical-session kiosk, readiness wait и watchdog.

Сначала прочитай весь документ, затем реализуй по фазам 0–9.
После каждой фазы проект должен собираться; добавляй и запускай относящиеся
к ней тесты. Не расширяй scope на cloud, БД, multilayer или media downloading.

Неизвестные model/RAM/OS/display не выдумывай. Сохрани их как pending hardware
facts. Для отсутствующего устройства подготовь scripts и acceptance checklist,
но пометь hardware tests как notRun.

В конце предоставь release artifact, README, тестовые результаты,
IMPLEMENTATION-STATUS.md и список реальных ограничений.
Не выдавай mock/demo/in-memory-only решение за готовый unattended kiosk.
```

---

## 26. Источники, происхождение решений и проверка фактов

### Исходные материалы

**S1.** Приложенный пользователем `pi-player-coding-agent-plan(1)(1).md`.
Из него сохранены назначение, .NET 10/Angular/SignalR, файловое хранение рядом
с приложением, flat libraries, presets, independent startup и общая структура фаз.

**S2.** Уточнённый пользовательский сценарий и замечания к S1:
Visual и Audio независимы; YouTube является видеослоем; direct audio URL;
viewport сообщается экраном; defaults не повторяются при reconnect;
screen подтверждает playback; kiosk ждёт backend и не требует клавиатуры.

Дополнения этого документа — конкретные проектные решения: схемы DTO,
generation/revision, default safety limits, recovery, security bootstrap,
watchdog policy, precise geometry и тестовая матрица. Они не являются сведениями
о фактически установленной Pi и не были проверены на её железе.

### Внешняя документация

Проверено при подготовке 7 сентября 2026 года. Перед выпуском интеграций
повторно проверить внешние требования: поведение платформ может изменяться.

**[R1] YouTube — Required Minimum Functionality.** Размер, видимость,
autoplay, overlays и Referer.  
`https://developers.google.com/youtube/terms/required-minimum-functionality`

**[R2] YouTube — Developer Policies.** Ограничения работы с аудиовизуальным контентом
и недопустимость hidden/background использования player.  
`https://developers.google.com/youtube/terms/developer-policies`

**[R3] YouTube — IFrame Player API Reference.** API, события, playback rates,
autoplayBlocked и provider errors.  
`https://developers.google.com/youtube/iframe_api_reference`

**[R4] YouTube — Embedded Players and Player Parameters.** Embed configuration,
loop, origin и deprecated параметры.  
`https://developers.google.com/youtube/player_parameters`

**[R5] Chrome — Autoplay policy.** Kiosk-related настройки, developer switch,
разрешения iframe и необходимость проверять результат play.  
`https://developer.chrome.com/blog/autoplay/`

**[R6] Microsoft — ASP.NET Core SignalR JavaScript client.** Начальный connect,
reconnect и клиентские callbacks.  
`https://learn.microsoft.com/en-us/aspnet/core/signalr/javascript-client?view=aspnetcore-10.0`

**[R7] Raspberry Pi — Kiosk mode tutorial.** SSH-setup и graphical-session autostart,
включая labwc в описанном окружении.  
`https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/`

**[R8] Microsoft — SignalR authentication and authorization.** Cookie authentication
и авторизация соединений/методов.  
`https://learn.microsoft.com/en-us/aspnet/core/signalr/authn-and-authz?view=aspnetcore-10.0`

**[R9] Microsoft — Upload files in ASP.NET Core.** Streaming uploads и независимые
framework/server ограничения размеров.  
`https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads?view=aspnetcore-10.0`

**[R10] WHATWG — HTML media elements.** Состояния и поведение video/audio,
playback и media resource loading.  
`https://html.spec.whatwg.org/multipage/media.html`

**[R11] Angular — Version compatibility.** Совместимость Angular, Node.js,
TypeScript и RxJS.  
`https://angular.dev/reference/versions`

**[R12] Microsoft — Deploy .NET apps to ARM single-board computers.**
Self-contained deployment и выбор target runtime.  
`https://learn.microsoft.com/en-us/dotnet/iot/deployment`

---

## Краткий журнал отличий от исходного плана

| Было | Стало |
|---|---|
| Animation + Music | Visual + независимый Audio. |
| YouTube как music source | YouTube video/playlist как Visual source. |
| YouTube 480×270 справа снизу | Общий editor геометрии, provider-specific ограничения, rotation capability gate. |
| Local music останавливает YouTube | Каналы не останавливают друг друга. |
| Web music фактически означала YouTube | Отдельный direct remoteAudioUrl. |
| Screen size default 1920×1080 | Фактический viewport от Pi, CSS-pixel semantics. |
| Transform origin center без подробного контракта | Явный top-left pivot, формулы и geometry tests. |
| Defaults по ScreenReady | Однократная initialization backend, reconnect -> current state. |
| Только команды и приблизительный runtime | Desired/observed, receipts, revisions, generations, checkpoints. |
| Необязательные kiosk scripts | Обязательные preflight, install, readiness wait и recovery. |
| Локальные playlists упомянуты без модели | Явно отложены; YouTube playlists сохранены. |
| Ограниченные проверки uploads/files | Streaming, Range, dependencies, recovery и security tests. |
| Неуточнённая аппаратная платформа | Отдельный hardware profile и честные статусы notRun. |
