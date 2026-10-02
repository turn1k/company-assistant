# Windows и macOS

Electron-клиент подключается к тому же HTTPS-серверу, что и веб-версия. На первом запуске адрес https://companyassistant.ru уже заполнен: достаточно нажать «Подключиться». При необходимости адрес можно изменить. Ключ OpenAI и база пользователей остаются на VPS. Клиент хранит только адрес сервера и cookie сеанса.

## Запуск и сборка

```sh
cd desktop
pnpm install --frozen-lockfile
pnpm start
# Windows, на Windows:
pnpm exec electron-builder --win --x64 --publish never
# macOS, на Mac:
pnpm exec electron-builder --mac --arm64 --x64 --publish never
```

Установщики появляются в `desktop/dist`. Альтернатива: GitHub Actions → Desktop installers → Run workflow. Сборка macOS требует runner на macOS. Workflow создаёт артефакты, а не публичный релиз.

Для штатного распространения нужны подпись Windows и Apple Developer ID / notarization для macOS; сертификаты должны храниться в CI Secrets. Без них сборки тестовые, ОС может блокировать или предупреждать при запуске. Текущий workflow не включает подпись и нотариализацию. До выдачи сотрудникам требуется проверка на реальных Windows/macOS, включая вход, скачивание и отзыв сеанса.

Remote renderer работает без Node.js, с sandbox/context isolation и ограничением навигации своим origin. Настройка адреса выполняется в отдельном локальном окне с ограниченным preload. Сертификаты HTTPS проверяются; обход ошибок сертификата не реализован.

Сборки запускаются также автоматически при изменении desktop/ в основной ветке. Имена файлов содержат версию, ОС и архитектуру: Windows x64, macOS arm64 (Apple Silicon) и x64 (Intel). Артефакты хранятся 30 дней. Веб-интерфейс загружается с сервера, поэтому его изменения не требуют переустановки клиента.
