Site Mirror — локальный инструмент зеркалирования сайтов

Кратко
- **Описание**: Desktop SPA-aware сайт-миратор, собранный на Electron + React + TypeScript. Поддерживает два режима захвата: встроенный (Playwright) и Browsertrix (через Docker/WACZ + ReplayWeb.page).
- **Цель**: сохранить локальную копию сайта (страницы, статические ресурсы, WACZ-архивы) и быстро просмотреть её в приложении или внешнем браузере.

Быстрый старт
- **Установить зависимости**: `npm install`
- **Запустить в режиме разработки**: `npm run dev` — запускает `electron-vite dev` (рендерер в режиме Vite + Electron main).
- **Собрать**: `npm run build` — `tsc --noEmit && electron-vite build`.
- **Упаковать дистрибутив**: `npm run dist` — выполняет `npm run build && electron-builder`.
- **Примечание**: в `package.json` есть `postinstall`, который запускает установку браузеров Playwright: `PLAYWRIGHT_BROWSERS_PATH=0 playwright install chromium`.

Требования
- **Node.js**: современная LTS-версия (рекомендуется Node 18+).
- **npm**: локальная версия менеджера пакетов.
- **Docker**: опционально — требуется только если вы хотите использовать Browsertrix (WACZ) режим.
- **Платформы**: проект ориентирован на десктоп; упаковка через `electron-builder` настроена для Windows (NSIS).

Ключевые возможности
- **Два движка захвата**: встроенный Playwright (динамическое рендеринг + скриншоты) и Browsertrix (через Docker → WACZ → ReplayWeb.page).
- **Локальный статический сервер**: отдаёт сохранённый сайт, подставляет CSP и поддерживает частичные range-запросы для медиа.
- **UI**: Electron + React интерфейс для настройки глубины, выбора папки и просмотра логов/прогресса.

Структура проекта (основные файлы)
- **Main process**: [src/main/main.ts](src/main/main.ts)
- **Краулер (Playwright)**: [src/main/crawler.ts](src/main/crawler.ts)
- **Browsertrix интеграция**: [src/main/browsertrixCrawler.ts](src/main/browsertrixCrawler.ts)
- **Локальный сервер**: [src/main/localServer.ts](src/main/localServer.ts)
- **Preload API**: [src/preload/preload.ts](src/preload/preload.ts)
- **Renderer (UI)**: [src/renderer/App.tsx](src/renderer/App.tsx)
- **Скрипты и конфигурация сборки**: [package.json](package.json)

Как это работает (вкратце)
- При старте приложения `main` создаёт окно рендера и обрабатывает IPC-команды от UI (`crawler:start`, `dialog:select-output-directory` и т.д.).
- При запуске краула сначала проверяется доступность Browsertrix (Docker). Если доступен — используется WACZ-пайплайн; иначе — встроенный Playwright.
- После сохранения копии запускается локальный сервер ([src/main/localServer.ts](src/main/localServer.ts)), и UI предоставляет ссылку для просмотра локальной копии.

Полезные примечания
- **Playwright**: большие бинарные браузеры скачиваются при `npm install` благодаря `postinstall` в `package.json`.
- **Browsertrix**: требует работающего Docker; логика проверяет `docker info` и в случае успеха запускает контейнер `webrecorder/browsertrix-crawler`.
- **CSP**: локальный сервер добавляет безопасную политику контента для корректного отображения зеркала и ограничения внешних переходов.
- **Сборка дистрибутива**: артефакты попадают в папку `release/` (см. `build.directories.output` в `package.json`).

Контрибьюция
- Открытые пул-реквесты и баги приветствуются. Для разработки: запустите `npm install` → `npm run dev` и вносите изменения в `src`.

Лицензия
- Этот проект использует лицензию: MIT (см. поле `license` в [package.json](package.json)).

Готово — что дальше?
- Если хотите, добавлю разделы с примерами сценариев использования, CI/CD-скриптом для сборки Windows-артефакта или сокращённой инструкцией по отладке краулера.
