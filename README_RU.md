# Buddha Chat Server v5 Sync

Backend для Android v2: хранит пользователей, чаты, сообщения, FCM-токены и отдаёт `/api/sync?since=...`, чтобы Android мог быстро открываться из локального кеша.

## Render

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
FIREBASE_SERVICE_ACCOUNT_JSON={...полный service account json из Firebase...}
```

Если Firebase JSON не указан, чат всё равно работает, но пуши не отправляются.
