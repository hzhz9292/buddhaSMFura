# Buddha Chat Native Android + FCM

Архив содержит две части:

1. `server-v4-fcm` — новый backend для Render/VDS. Он хранит пользователей/чаты/сообщения, принимает FCM-токены и отправляет Android push.
2. `android-native-fcm` — нативное Android-приложение без WebView и без звонков. Есть вход, регистрация, чаты, поиск, настройки, удаление сообщений/чатов, FCM-пуши.

Звонков в этой версии нет специально. Сначала тестируем нормальную нативную основу и пуши.

---

## 1. Залить server-v4-fcm на GitHub

Создай новый репозиторий или замени старый backend.

В корне GitHub должны лежать файлы именно из папки `server-v4-fcm`:

```text
server.js
package.json
.env.example
data/
uploads/
```

---

## 2. Render настройки

Render → New Web Service → выбрать GitHub-репозиторий.

Build Command:

```bash
npm install --no-audit --no-fund
```

Start Command:

```bash
node server.js
```

Environment Variables:

```text
NODE_VERSION=20
SESSION_SECRET=любой-длинный-секрет
INVITE_CODE=FAMILY2026
ADMIN_USERNAME=Buddha
ADMIN_PASSWORD=61
ADMIN_DISPLAY_NAME=Buddha
```

Пока без Firebase сервер тоже запустится, но пуши работать не будут.

---

## 3. Firebase для Android push

1. Зайди в Firebase Console.
2. Create project.
3. Add app → Android.
4. Android package name:

```text
com.buddhachat.nativeapp
```

5. Скачай файл:

```text
google-services.json
```

6. Положи его в Android-проект сюда:

```text
android-native-fcm/app/google-services.json
```

7. В Firebase Console открой:

```text
Project settings → Service accounts → Generate new private key
```

Скачается JSON service account. Открой его, скопируй содержимое в одну строку и добавь в Render env:

```text
FIREBASE_SERVICE_ACCOUNT_JSON={...весь json...}
```

Можно вставить и многострочно, если Render позволяет. Главное, чтобы это был валидный JSON.

После этого в Render нажми Manual Deploy.

---

## 4. Открыть Android-проект

1. Распакуй архив.
2. Перенеси папку:

```text
android-native-fcm
```

в путь без русских букв, например:

```text
C:\android\android-native-fcm
```

3. Убедись, что `google-services.json` лежит тут:

```text
C:\android\android-native-fcm\app\google-services.json
```

4. Android Studio → File → Open → выбери папку:

```text
C:\android\android-native-fcm
```

5. Дождись Gradle Sync.
6. Подключи Android-телефон.
7. Включи USB debugging.
8. Нажми Run.

---

## 5. Вход в приложение

В первом поле вставь ссылку Render, например:

```text
https://your-project.onrender.com
```

Тестовые аккаунты:

```text
Buddha / 61
user2 / 123456
```

Invite для новых аккаунтов:

```text
FAMILY2026
```

---

## 6. Как тестить на двух Android

1. Установи приложение на первый Android.
2. Войди как `Buddha / 61`.
3. Установи то же приложение на второй Android.
4. Войди как `user2 / 123456`.
5. На каждом нажми `Настройки → Обновить FCM-токен / уведомления`.
6. Напиши сообщение с одного телефона на другой.

Логика пушей: если получатель сидит именно в этом чате, push не отправляется. Если он не в этом чате или приложение закрыто — должен прийти FCM push.

---

## 7. Что есть

- нативный Android, не WebView;
- вход/регистрация по invite;
- нижнее меню: Чаты / Поиск / Настройки;
- поиск по username;
- личные чаты;
- обновление сообщений polling каждые 2.5 секунды;
- FCM-пуши;
- удаление сообщения у себя/у всех;
- очистка/удаление чата у себя/у всех;
- без звонков.

---

## 8. Если Android Studio ругается

### `google-services.json is missing`

Ты не положил Firebase-файл в `app/google-services.json`.

### `Non-ASCII path`

Перенеси проект в `C:\android\android-native-fcm`.

### Push не приходит

Проверь:

1. В Android есть разрешение уведомлений.
2. В приложении нажал `Настройки → Обновить FCM-токен`.
3. На Render задан `FIREBASE_SERVICE_ACCOUNT_JSON`.
4. Render перезапущен после добавления env.
5. Получатель не находится прямо в том же чате.

