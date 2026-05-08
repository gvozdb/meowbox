# VPN Management — спецификация

**Статус:** draft
**Дата:** 2026-05-09
**Автор:** Pavel
**Slug:** `vpn-management`

---

## 1. Цели и не-цели

### 1.1 Цели

- Развёртывание VPN-сервера на любом сервере панели **в один клик** из web-UI.
- Управление VPN-юзерами (создать / отключить / удалить / показать конфиг + QR / выдать subscription URL).
- Поддержка **двух типов** VPN на старте, с архитектурой, расширяемой на N типов:
  - **VLESS + Reality** (Xray-core) — primary, обход DPI/TSPU.
  - **AmneziaWG** — secondary fallback, обфусцированный WireGuard.
- На одном сервере допустимо **несколько VPN-сервисов одновременно** (разные протоколы, разные порты).
- Кастомный порт указывается при деплое из UI (не хардкод 443).
- Автоматическая периодическая проверка доступности SNI-маски (для Reality) — если маска перестала отдавать TLS, в UI горит warning + push-уведомление.
- Ротация Reality-ключей и SNI-маски одной кнопкой.

### 1.2 Не-цели (явно вне scope)

- **Учёт трафика per-user, лимиты, биллинг** — VPN личный, не нужно.
- **Multi-server load balancing** одного юзера через subscription с N серверами — позже, не в MVP.
- **Связь VPN-юзера с юзером сервера** (которому даём SSH/SFTP доступ) — это разные сущности, не привязываем.
- **Поддержка legacy-протоколов** (OpenVPN, ванильный WireGuard, Trojan, Shadowsocks) — на старте не нужно, проще банятся, не лезем.
- **Web-клиент VPN** (browser-based) — нет, только нативные клиенты.

---

## 2. Выбор протоколов

### 2.1 VLESS + Reality (primary)

**Почему:** на 2026 год это де-факто стандарт обхода TSPU/DPI в РФ. Reality маскирует трафик под настоящий TLS handshake к стороннему сайту (`google.com`, `yandex.ru`, `microsoft.com`, `discordapp.com` и т.п.), без X.509-сертификата на VPN-сервере. Active probing провайдером не палит — для прокидки используется реальный fingerprint цели.

**Стек:** [Xray-core](https://github.com/XTLS/Xray-core), статический бинарник, без apt-зависимостей.

**Транспорт:** TCP (Reality пока только TCP).

**Шифры:** TLS 1.3, X25519, Chacha20-Poly1305 / AES-128-GCM (по выбору клиента).

### 2.2 AmneziaWG (secondary)

**Почему:** российская модификация WireGuard от команды Amnezia (опенсорс). Добавляет в WG-handshake junk-пакеты переменной длины и обфусцированные magic header'ы, чтобы handshake не определялся сигнатурным DPI как WireGuard. Кроссплатформенные клиенты Amnezia — самые удобные на рынке (всё-в-одном, QR-код, subscription).

**Стек:** [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go) + `amneziawg-tools`. На бэкенде пакет ставится из репозитория Amnezia (`ppa:amnezia/ppa` для Ubuntu/Debian) или собирается из исходников.

**Транспорт:** UDP.

### 2.3 Сравнительная таблица

| | VLESS+Reality | AmneziaWG |
|--|--|--|
| Транспорт | TCP | UDP |
| Маскировка | под TLS-сайт | obfusc'ed WG handshake |
| Скорость | средняя (TCP overhead) | высокая (UDP) |
| Стабильность DPI-обхода (РФ 2026) | очень высокая | высокая |
| Состояние клиентов | много вариантов | один отличный (Amnezia) |
| Зависит от внешнего домена-маски | да (риск SNI-бана) | нет |
| Кастомный порт | да | да |

### 2.4 Архитектурный задел на будущие протоколы

Если завтра кто-то начнёт банить Reality по handshake-сигнатуре или AmneziaWG по UDP-pattern — хотим за день докинуть третий протокол. Кандидаты:

- **Hysteria2** (UDP/QUIC, очень быстрый, неплохо обфусцируется);
- **TUIC v5** (UDP/QUIC, brutal congestion control);
- **sing-box VLESS+Vision** (TCP+TLS+uTLS, отдельный от Reality);
- **ShadowTLS v3** + Shadowsocks-2022.

Под архитектуру плагинов добавляются как новый `VpnProvider` без изменения core.

---

## 3. Клиенты

Для VLESS+Reality, **бесплатные**, по платформам — рекомендации в порядке приоритета:

### 3.1 iOS

1. **Streisand** ([App Store](https://apps.apple.com/app/streisand/id6450534064)) — рекомендуется по умолчанию.
   Бесплатный, без рекламы, поддерживает VLESS+Reality, Shadowsocks, Trojan, Hysteria2, WireGuard. Subscription URL. Минималистичный UI.
2. **FoXray** ([App Store](https://apps.apple.com/app/foxray/id6448898396)) — альтернатива. Бесплатный.
3. **Hiddify Next** ([App Store](https://apps.apple.com/app/hiddify-next/id6596777532)) — для тех, кто хочет advanced-фичи (роутинг, DNS-правила).

> **Shadowrocket** — платный, не нужен.

### 3.2 macOS

1. **V2Box** ([App Store](https://apps.apple.com/app/v2box-v2ray-client/id6446814690)) — бесплатный, нативный, простой UI.
2. **FoXray** — тот же, кросс-платформа iOS/macOS, синхронизация subscription через iCloud.
3. **Hiddify Next** ([Releases](https://github.com/hiddify/hiddify-next/releases)) — Electron, тяжелее, но мощный.

### 3.3 Android

1. **v2rayNG** ([F-Droid](https://f-droid.org/packages/com.v2ray.ang/) / [GitHub](https://github.com/2dust/v2rayNG)) — золотой стандарт.
2. **NekoBox for Android** — альтернатива.
3. **Hiddify Next** — для advanced.

### 3.4 Windows

1. **NekoRay / NekoBox** ([GitHub](https://github.com/MatsuriDayo/nekoray)) — бесплатный, основной.
2. **Hiddify Next**.
3. **v2rayN** ([GitHub](https://github.com/2dust/v2rayN)).

### 3.5 Linux

1. **NekoRay**.
2. **Hiddify Next**.

### 3.6 Для AmneziaWG — единый клиент на все платформы

[**Amnezia VPN**](https://amnezia.org/) — официальный клиент команды Amnezia. iOS / macOS / Android / Windows / Linux. Бесплатный, опенсорс. Через QR/subscription.

> На странице юзера в панели показываем **deep-link** с QR + ссылку на скачку клиента под платформу пользователя.

---

## 4. Архитектура

### 4.1 Strategy pattern для провайдеров

Новый модуль `api/src/vpn/` + плагины в `api/src/vpn/providers/`. Аналогично — `agent/src/vpn/` на стороне агента.

```ts
// shared/src/vpn-types.ts
export enum VpnProtocol {
  VLESS_REALITY = 'vless_reality',
  AMNEZIA_WG    = 'amnezia_wg',
}

export enum VpnServiceStatus {
  RUNNING   = 'RUNNING',
  STOPPED   = 'STOPPED',
  ERROR     = 'ERROR',
  DEPLOYING = 'DEPLOYING',
}

export interface VpnInstallOptions {
  protocol: VpnProtocol;
  port: number;
  // VLESS+Reality:
  sniMask?: string;       // например 'www.google.com'
  // AmneziaWG:
  network?: string;       // CIDR пула, default '10.13.13.0/24'
  dns?: string[];         // default ['1.1.1.1','8.8.8.8']
  mtu?: number;           // default 1280
}

export interface VpnUserCreds {
  // VLESS: vless://uuid@host:port?security=reality&...
  // AmneziaWG: amnezia://... или wg-quick конфиг
  configUrl: string;
  qrPng: Buffer;          // QR в PNG, base64-кодированный для UI
  raw: string;            // wg-conf или vless-link plain
}
```

### 4.2 Интерфейс провайдера

```ts
// api/src/vpn/providers/vpn-provider.interface.ts
export interface VpnProvider {
  readonly protocol: VpnProtocol;

  /** Развернуть сервис на сервере. Идемпотентно: если уже развёрнут — возвращает текущее состояние. */
  install(server: Server, opts: VpnInstallOptions): Promise<{ port: number; configBlob: string }>;

  /** Полное удаление сервиса (бинарь, конфиги, systemd unit). */
  uninstall(server: Server, serviceId: string): Promise<void>;

  /** Текущий статус (RUNNING/STOPPED/ERROR + детали). */
  status(server: Server, serviceId: string): Promise<{ status: VpnServiceStatus; details?: string }>;

  /** Создать VPN-юзера, вернуть его credentials. */
  addUser(server: Server, serviceId: string, name: string): Promise<VpnUserCreds>;

  /** Отозвать юзера (мягко: enable=false). */
  disableUser(server: Server, serviceId: string, userId: string): Promise<void>;

  /** Включить отозванного. */
  enableUser(server: Server, serviceId: string, userId: string): Promise<void>;

  /** Удалить юзера полностью. */
  removeUser(server: Server, serviceId: string, userId: string): Promise<void>;

  /** Получить creds существующего юзера (для повторного показа QR). */
  getUserCreds(server: Server, serviceId: string, userId: string): Promise<VpnUserCreds>;

  /** Ротация ключей сервиса (для Reality — x25519 keypair, для WG — server keypair). */
  rotateServerKeys(server: Server, serviceId: string): Promise<void>;

  /** Только для Reality: смена SNI-маски. */
  rotateSniMask?(server: Server, serviceId: string, newSni: string): Promise<void>;

  /** Только для Reality: проверить, что SNI отдаёт TLS 1.3 + X25519 с сервера. */
  validateSniMask?(server: Server, sni: string): Promise<{ ok: boolean; reason?: string }>;
}
```

### 4.3 Registry

```ts
// api/src/vpn/vpn.registry.ts
@Injectable()
export class VpnRegistry {
  constructor(
    private readonly xrayReality: XrayRealityProvider,
    private readonly amneziaWg: AmneziaWgProvider,
  ) {}

  get(protocol: VpnProtocol): VpnProvider {
    switch (protocol) {
      case VpnProtocol.VLESS_REALITY: return this.xrayReality;
      case VpnProtocol.AMNEZIA_WG:    return this.amneziaWg;
    }
    throw new Error(`Unknown VPN protocol: ${protocol}`);
  }

  list(): VpnProtocol[] {
    return [VpnProtocol.VLESS_REALITY, VpnProtocol.AMNEZIA_WG];
  }
}
```

### 4.4 Провайдер исполняется на агенте, API — оркестратор

**API** хранит модель в БД, шифрует приватные ключи, валидирует ввод, отдаёт UI данные.
**Agent** реально выполняет команды на сервере (apt install, systemctl, Xray gen, генерация WG-ключей, запись конфигов).

Связь: API → `agent.gateway.ts` (Socket.io) → `agent/src/vpn/handler.ts`.

Провайдер на API — тонкая обёртка, которая шлёт RPC-команду агенту. Реальная имплементация — на агенте.

---

## 5. Модель данных (Prisma)

```prisma
// api/prisma/schema.prisma

model VpnService {
  id          String   @id @default(cuid())
  serverId    String
  protocol    String   // VpnProtocol
  port        Int
  status      String   // VpnServiceStatus
  // Зашифрованный JSON: для VLESS+Reality { privKey, pubKey, shortId, sniMask, fingerprint };
  // для AmneziaWG   { srvPriv, srvPub, network, dns, mtu, jc, jmin, jmax, s1, s2, h1, h2, h3, h4 }.
  configBlob       String
  // SNI-маска отдельным полем для индексации/UI; для AmneziaWG = null.
  sniMask          String?
  sniLastCheckOk   Boolean?
  sniLastCheckedAt DateTime?
  sniLastError     String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  server      Server   @relation(fields: [serverId], references: [id], onDelete: Cascade)
  users       VpnUser[]

  @@index([serverId])
  @@index([protocol])
}

model VpnUser {
  id         String   @id @default(cuid())
  serviceId  String
  name       String                          // отображаемое имя (произвольное), уникально per-service
  enabled    Boolean  @default(true)
  // Зашифрованный JSON: для VLESS { uuid, flow }; для AmneziaWG { peerPriv, peerPub, peerPsk, peerIp }.
  credsBlob  String
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  service    VpnService @relation(fields: [serviceId], references: [id], onDelete: Cascade)

  @@unique([serviceId, name])
  @@index([serviceId])
}
```

**Миграция:** `npx prisma migrate dev --name vpn-management`.

---

## 6. Безопасность

### 6.1 Шифрование приватных ключей

Создаём `api/src/common/crypto/vpn-cipher.ts` по образцу `credentials-cipher.ts`:

```
Источник master-key:
  1. ENV `VPN_SECRET_KEY` (32 байта в base64) — override для prod.
  2. Файл `${MEOWBOX_DATA_DIR}/.vpn-key` (32 байта бинарных, perms 600).
  3. Если ничего нет — автоген при первом обращении, сохраняется в файл.
```

Шифр AES-256-GCM, формат `iv(12)|tag(16)|ciphertext`.

Шифруются:
- `VpnService.configBlob` — в т.ч. **серверный приватный ключ** Reality / WG.
- `VpnUser.credsBlob` — UUID для VLESS, peer-priv/peer-psk для WG.

Системная миграция `2026-05-09-001-vpn-secret-bootstrap.ts` создаёт файл если его нет — идемпотентно.

### 6.2 Прочее

- На агенте все конфиги VPN живут в `/opt/meowbox/state/vpn/{serviceId}/` с правами 600 для приватных частей и 644 для публичных.
- Systemd unit запускается от непривилегированного юзера `meowbox-vpn` (создаётся миграцией `useradd`), кроме случаев когда нужен root для tun-устройства (AmneziaWG) — тогда `User=root` + `AmbientCapabilities=CAP_NET_ADMIN`.
- В firewall (`agent/src/firewall/*` или прямой ufw) автоматически открывается выбранный порт TCP/UDP при деплое и закрывается при uninstall. **Не open all** — только конкретный порт.
- API логи **не пишут** приватные ключи / UUID юзеров (маскируем при логировании).

### 6.3 Доступ через UI

VPN-страница доступна **только** юзерам панели с ролью `ADMIN` (см. `UserRole` enum). Создание/просмотр конфигов VPN-юзеров — admin-only.

---

## 7. Реализация: VLESS + Reality

### 7.1 Системная миграция

`migrations/system/2026-05-09-002-install-xray.ts`:

1. Если `/usr/local/bin/xray` уже есть и `xray version` выводит >= 1.8 — skip.
2. Скачивает статический бинарник с GitHub releases (https://github.com/XTLS/Xray-core/releases/latest), распаковывает в `/usr/local/bin/xray`.
3. Кладёт пустой каталог `/etc/xray/` (ownership root:root, 755).
4. Создаёт юзера `meowbox-vpn` (useradd, без shell, без home).

**Идемпотентность:** проверка наличия binary + версии перед скачкой; `id meowbox-vpn` перед useradd; etc.

### 7.2 Деплой сервиса (`XrayRealityProvider.install`)

1. **Валидация SNI-маски** через `validateSniMask`:
   ```bash
   openssl s_client -connect ${sni}:443 -servername ${sni} -tls1_3 -groups X25519 < /dev/null 2>&1
   ```
   проверяем что handshake успешен, версия = TLSv1.3, группа = X25519.
   Если нет — возвращаем ошибку до записи в БД.

2. **Генерация ключей:**
   ```bash
   xray x25519
   ```
   → `Private key: ...`, `Public key: ...`.
   `shortId` = `crypto.randomBytes(8).toString('hex')`.

3. **Конфиг** `/opt/meowbox/state/vpn/{serviceId}/config.json`:
   ```json
   {
     "log": { "loglevel": "warning" },
     "inbounds": [{
       "tag": "vless-reality-in",
       "listen": "0.0.0.0",
       "port": <port>,
       "protocol": "vless",
       "settings": {
         "clients": [],
         "decryption": "none"
       },
       "streamSettings": {
         "network": "tcp",
         "security": "reality",
         "realitySettings": {
           "show": false,
           "dest": "<sniMask>:443",
           "xver": 0,
           "serverNames": ["<sniMask>"],
           "privateKey": "<xrayPrivKey>",
           "shortIds": ["<shortId>"]
         }
       },
       "sniffing": { "enabled": true, "destOverride": ["http","tls","quic"] }
     }],
     "outbounds": [{ "protocol": "freedom", "tag": "direct" }]
   }
   ```
   Юзеры (`clients` array) добавляются через `addUser` — обновляем JSON и перезагружаем сервис.

4. **Systemd unit** `/etc/systemd/system/meowbox-vpn-{serviceId}.service`:
   ```ini
   [Unit]
   Description=Meowbox VPN (Xray Reality) — {serviceId}
   After=network.target nss-lookup.target

   [Service]
   User=meowbox-vpn
   ExecStart=/usr/local/bin/xray run -c /opt/meowbox/state/vpn/{serviceId}/config.json
   Restart=on-failure
   RestartSec=5
   AmbientCapabilities=CAP_NET_BIND_SERVICE
   NoNewPrivileges=true
   ProtectSystem=strict
   ReadWritePaths=/opt/meowbox/state/vpn/{serviceId}
   PrivateTmp=true

   [Install]
   WantedBy=multi-user.target
   ```

5. `systemctl daemon-reload && systemctl enable --now meowbox-vpn-{serviceId}`.

6. Открыть порт TCP в firewall.

7. Записать в БД `VpnService` с зашифрованным `configBlob`.

### 7.3 Создание юзера (`addUser`)

1. Сгенерировать UUID v4.
2. Прочитать конфиг JSON, добавить в `inbounds[0].settings.clients`:
   ```json
   { "id": "<uuid>", "flow": "xtls-rprx-vision", "email": "<userName>" }
   ```
3. Записать конфиг, `systemctl reload meowbox-vpn-{serviceId}` (или restart, если reload не поддерживается — Xray поддерживает `kill -HUP`).
4. Сохранить в `VpnUser` зашифрованные `{ uuid, flow: 'xtls-rprx-vision' }`.
5. Сгенерировать **VLESS URL:**
   ```
   vless://<uuid>@<server.host>:<port>?
     encryption=none&
     flow=xtls-rprx-vision&
     security=reality&
     sni=<sniMask>&
     fp=chrome&
     pbk=<publicKey>&
     sid=<shortId>&
     type=tcp&
     headerType=none
     #<urlencoded userName>
   ```
6. Сгенерировать QR-код (npm `qrcode` уже не нужно ставить — есть в exo? проверить, скорее всего ставим: `npm i qrcode` в `api/`).
7. Вернуть `{ configUrl, qrPng, raw: configUrl }`.

### 7.4 Отзыв юзера (`disableUser`)

- Убрать из `inbounds[0].settings.clients` по UUID, reload Xray, в БД `enabled=false` (creds оставляем для возможного re-enable).

### 7.5 Ротация SNI-маски

`rotateSniMask(newSni)`:
1. Валидация newSni (`validateSniMask`).
2. Изменить `realitySettings.dest` и `serverNames` в конфиге.
3. Reload Xray.
4. Обновить `sniMask` в БД и **повторно сгенерировать VLESS URL'ы для всех юзеров** (UUID не меняется, но subscription URL динамический — он соберёт URL'ы из БД на лету, это автоматом).

> ⚠️ После ротации SNI **всем юзерам нужно перезагрузить subscription** в клиенте. Если клиент не подтягивает — конфиг старый.

### 7.6 Auto-check SNI

Cron на API раз в **6 часов** (через существующий cron-модуль): для каждого `VpnService` с `protocol=VLESS_REALITY` агент делает `validateSniMask(currentSni)`. Результат пишется в `sniLastCheckOk` / `sniLastCheckedAt` / `sniLastError`. Если `ok=false` дважды подряд — push-уведомление админу + красный warning в UI на странице сервиса.

> Это **не означает что юзеры не могут подключиться** (проверка идёт с сервера, а у юзеров может быть другая сеть/SNI-блок), но это сильный сигнал что маска померла или сайт-цель сменил TLS-fingerprint.

---

## 8. Реализация: AmneziaWG

### 8.1 Системная миграция

`migrations/system/2026-05-09-003-install-amneziawg.ts`:

1. Идемпотентная проверка: `dpkg -l amneziawg` или `which awg` → если есть, skip.
2. Добавить ppa: `add-apt-repository ppa:amnezia/ppa -y` (для Ubuntu) либо аналог для Debian (есть на офсайте Amnezia).
3. `apt update && apt install -y amneziawg amneziawg-tools`.
4. `modprobe amneziawg` + проверка что модуль загрузился.
5. Включить ip_forward: `sysctl -w net.ipv4.ip_forward=1` + `/etc/sysctl.d/99-meowbox-vpn.conf`.

### 8.2 Деплой сервиса (`AmneziaWgProvider.install`)

1. **Генерация серверного keypair:**
   ```bash
   awg genkey | tee /opt/meowbox/state/vpn/{serviceId}/srv.key | awg pubkey > /opt/meowbox/state/vpn/{serviceId}/srv.pub
   chmod 600 /opt/meowbox/state/vpn/{serviceId}/srv.key
   ```
2. **Параметры обфускации** (генерим случайно при деплое):
   - `Jc` (junk packet count): random 3..10.
   - `Jmin`, `Jmax` (junk packet size range): `Jmin=50`, `Jmax=1000`.
   - `S1`, `S2` (init/response packet padding): random 0..200.
   - `H1`..`H4` (magic headers): random uint32, **разные между собой**, **не дефолтные WG-значения** (1,2,3,4).
3. **Network**: default `10.13.13.0/24`, server IP `10.13.13.1`. Юзерам выделяем `10.13.13.2..254`.
4. **Конфиг** `/etc/amneziawg/awg-{serviceId}.conf`:
   ```ini
   [Interface]
   PrivateKey = <srvPriv>
   ListenPort = <port>
   Address = 10.13.13.1/24
   PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -t nat -A POSTROUTING -o <egress-iface> -j MASQUERADE
   PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -t nat -D POSTROUTING -o <egress-iface> -j MASQUERADE
   Jc = <Jc>
   Jmin = <Jmin>
   Jmax = <Jmax>
   S1 = <S1>
   S2 = <S2>
   H1 = <H1>
   H2 = <H2>
   H3 = <H3>
   H4 = <H4>

   # Peers added dynamically — не редактировать вручную:
   ```
   Где `<egress-iface>` определяется через `ip route show default | awk '/default/ {print $5; exit}'`.
5. **Systemd unit** через стандартный `awg-quick@awg-{serviceId}.service`:
   ```bash
   systemctl enable --now awg-quick@awg-{serviceId}
   ```
6. Открыть UDP-порт в firewall.
7. Записать в БД с зашифрованным `configBlob` (включая параметры обфускации).

### 8.3 Создание юзера (`addUser`)

1. Сгенерировать peer keypair (`awg genkey | awg pubkey`) + PSK (`awg genpsk`).
2. Выделить следующий свободный IP в подсети (`10.13.13.<N>`). Учёт через БД: `MAX(peerIp)+1` или явный счётчик в `VpnService.configBlob`.
3. Добавить peer в конфиг сервера (динамически через `awg set` без перезапуска):
   ```bash
   awg set awg-{serviceId} peer <peerPub> preshared-key /tmp/psk allowed-ips 10.13.13.<N>/32
   ```
   + дописать в `awg-{serviceId}.conf` блок Peer (для persistance после reboot).
4. Сохранить в `VpnUser.credsBlob` зашифрованные `{ peerPriv, peerPub, peerPsk, peerIp }`.
5. **Сгенерировать клиентский конфиг** (один из двух форматов):
   - **Amnezia native** (deep-link `amnezia://...`) — base64-JSON со всеми параметрами обфускации.
   - **wg-quick-style** (для clients which support AmneziaWG):
     ```ini
     [Interface]
     PrivateKey = <peerPriv>
     Address = 10.13.13.<N>/32
     DNS = 1.1.1.1, 8.8.8.8
     Jc = ...
     Jmin = ...
     Jmax = ...
     S1 = ...
     S2 = ...
     H1 = ...
     H2 = ...
     H3 = ...
     H4 = ...

     [Peer]
     PublicKey = <srvPub>
     PresharedKey = <peerPsk>
     Endpoint = <server.host>:<port>
     AllowedIPs = 0.0.0.0/0, ::/0
     PersistentKeepalive = 25
     ```
6. QR + raw-конфиг в ответе.

### 8.4 Отзыв / удаление

`awg set awg-{serviceId} peer <peerPub> remove` + удалить блок из `.conf` + БД-флаг.

---

## 9. Subscription URL

Endpoint: `GET /api/vpn/sub/:userToken`

Где `userToken` — рандомный 32-байтный токен, выданный при создании юзера панели (хранится в `User.vpnSubToken`, регенерируется по запросу).

Возвращает **plain text, base64-encoded**, формат [v2rayN/Streisand subscription](https://github.com/XTLS/Xray-core/discussions/716):

```
<base64(
  vless://...#<name1>\n
  vless://...#<name2>\n
  ...
  amnezia://...#<wg-name1>\n
  ...
)>
```

Один токен = один админ панели = все его VPN-юзеры **со всех серверов** в одном subscription. Удобно: добавил один URL в клиент, дальше кнопкой «refresh» подтягиваешь новых юзеров после ротации SNI/ключей.

> Endpoint не требует JWT, **но** требует валидный `userToken`. Защита от перебора — rate-limit per IP (5 req/min, существующий nginx rate-limit модуль).

---

## 10. UI

### 10.1 Страница `/vpn` (список сервисов на текущем сервере)

- Таблица: Тип / Порт / SNI (если применимо) / Статус / Кол-во юзеров / Создан.
- Кнопка **«Развернуть VPN»** → модалка:
  - Радио: VLESS+Reality / AmneziaWG.
  - Поле «Порт» (default 443 для VLESS, 51820 для AmneziaWG, валидация 1-65535 + проверка занятости).
  - Если VLESS+Reality:
    - Селект SNI-маски (предзаполненный список: `www.google.com`, `www.microsoft.com`, `www.cloudflare.com`, `discordapp.com`, `addons.mozilla.org`) + поле «свой».
    - Кнопка «Проверить SNI» (вызывает `validateSniMask`).
  - Если AmneziaWG:
    - Поле «Подсеть» (default `10.13.13.0/24`).
    - Поле «DNS» (default `1.1.1.1, 8.8.8.8`).
    - Поле «MTU» (default 1280, advanced collapsible).
  - Кнопка **«Развернуть»** → API создаёт `VpnService` со статусом `DEPLOYING`, агент работает, по завершении статус → `RUNNING` + push в UI через socket.

### 10.2 Страница `/vpn/:serviceId`

- Header: тип, порт, статус, SNI (для Reality) с индикатором зелёный/красный по `sniLastCheckOk`.
- Кнопки: «Стоп / Старт», «Удалить сервис» (confirm), «Ротировать ключи», «Сменить SNI» (для Reality).
- Таблица VPN-юзеров: Имя / Создан / Включён / [Конфиг (QR)] / [Удалить].
- Кнопка **«Добавить юзера»** → модалка с полем «Имя», кнопкой «Создать» → показ QR + кнопок «Скопировать URL» / «Скачать .conf» / «Открыть в Amnezia» (deep-link).

### 10.3 Сайдбар

Добавить пункт «VPN» (icon = щит) после «Серверы». Доступен только админу.

### 10.4 Subscription page

Страница `/vpn/subscription` (для текущего юзера панели):
- Показывает subscription URL.
- Кнопка «Перегенерировать токен».
- QR-код subscription URL.

---

## 11. Backend endpoints (NestJS)

```
POST   /api/vpn/services                       create VpnService (deploy)
GET    /api/vpn/services?serverId=...          list
GET    /api/vpn/services/:id                   detail
DELETE /api/vpn/services/:id                   uninstall
POST   /api/vpn/services/:id/start
POST   /api/vpn/services/:id/stop
POST   /api/vpn/services/:id/rotate-keys
POST   /api/vpn/services/:id/rotate-sni        body: { newSni }
POST   /api/vpn/services/:id/validate-sni      body: { sni }

GET    /api/vpn/services/:id/users             list users
POST   /api/vpn/services/:id/users             body: { name }
GET    /api/vpn/services/:id/users/:userId/creds   re-fetch QR + URL
PATCH  /api/vpn/services/:id/users/:userId     body: { enabled }
DELETE /api/vpn/services/:id/users/:userId

GET    /api/vpn/sub/:userToken                 plaintext base64 subscription
POST   /api/vpn/me/regenerate-sub-token        rotate token of current panel user
```

Все, кроме `/sub/:userToken`, требуют JWT + role=ADMIN.

---

## 12. Agent RPC (Socket.io события)

Добавляются в `agent.gateway.ts`:

```
vpn:install           { serviceId, protocol, opts } → { configBlob }
vpn:uninstall         { serviceId, protocol } → { ok }
vpn:status            { serviceId, protocol } → { status, details }
vpn:add-user          { serviceId, protocol, userId, name, configBlob } → { credsBlob, configUrl, qrPng }
vpn:remove-user       { serviceId, protocol, userId } → { ok }
vpn:enable-user       { serviceId, protocol, userId } → { ok }
vpn:disable-user      { serviceId, protocol, userId } → { ok }
vpn:rotate-keys       { serviceId, protocol } → { newConfigBlob }
vpn:rotate-sni        { serviceId, newSni } → { ok }
vpn:validate-sni      { sni } → { ok, reason? }
```

Тимаут — стандартный 120s, как у остальных команд агента.

---

## 13. Шаблоны и файлы

### 13.1 На сервере (агент создаёт)

- `/opt/meowbox/state/vpn/{serviceId}/config.json` (Xray) — 600 root:meowbox-vpn
- `/etc/amneziawg/awg-{serviceId}.conf` (AmneziaWG) — 600 root:root
- `/etc/systemd/system/meowbox-vpn-{serviceId}.service` (Xray) — 644 root:root
- `awg-quick@awg-{serviceId}.service` — стандартный, не наш

### 13.2 Templates в shared

`shared/src/vpn-defaults.ts` — defaults: список SNI-масок, default-порты, network для WG, набор пакетов клиентов и ссылки на скачку.

```ts
export const DEFAULT_SNI_MASKS = [
  'www.google.com',
  'www.microsoft.com',
  'www.cloudflare.com',
  'addons.mozilla.org',
  'discordapp.com',
  'www.apple.com',
];

export const DEFAULT_VPN_PORTS = {
  [VpnProtocol.VLESS_REALITY]: 443,
  [VpnProtocol.AMNEZIA_WG]: 51820,
};

export const VPN_CLIENT_LINKS = {
  ios: {
    streisand: 'https://apps.apple.com/app/streisand/id6450534064',
    foxray:    'https://apps.apple.com/app/foxray/id6448898396',
    amnezia:   'https://apps.apple.com/app/amneziavpn/id1600529900',
  },
  macos: {
    v2box:   'https://apps.apple.com/app/v2box-v2ray-client/id6446814690',
    foxray:  'https://apps.apple.com/app/foxray/id6448898396',
    amnezia: 'https://amnezia.org/downloads',
  },
  android: {
    v2rayng: 'https://github.com/2dust/v2rayNG/releases/latest',
    nekobox: 'https://github.com/MatsuriDayo/NekoBoxForAndroid/releases/latest',
    amnezia: 'https://amnezia.org/downloads',
  },
  windows: {
    nekoray: 'https://github.com/MatsuriDayo/nekoray/releases/latest',
    hiddify: 'https://github.com/hiddify/hiddify-next/releases/latest',
    amnezia: 'https://amnezia.org/downloads',
  },
  linux: {
    nekoray: 'https://github.com/MatsuriDayo/nekoray/releases/latest',
    amnezia: 'https://amnezia.org/downloads',
  },
};
```

---

## 14. План реализации по фазам

### Фаза 1 — MVP VLESS+Reality (1 неделя)

- [ ] Prisma migration `vpn-management` (модели VpnService, VpnUser).
- [ ] System migration `2026-05-09-001-vpn-secret-bootstrap` (`.vpn-key`).
- [ ] System migration `2026-05-09-002-install-xray`.
- [ ] `api/src/common/crypto/vpn-cipher.ts`.
- [ ] `shared/src/vpn-types.ts`, `shared/src/vpn-defaults.ts`.
- [ ] `api/src/vpn/` модуль: registry, провайдеры, controller, service.
- [ ] `api/src/vpn/providers/xray-reality.provider.ts` (тонкий, шлёт RPC агенту).
- [ ] `agent/src/vpn/` модуль: handler.ts + xray.ts.
- [ ] Endpoint subscription URL.
- [ ] Web: страница `/vpn`, `/vpn/:serviceId`, модалки, сайдбар.
- [ ] QR-генерация (`qrcode` npm).
- [ ] Smoke test на dev-сервере.

### Фаза 2 — AmneziaWG (3 дня после фазы 1)

- [ ] System migration `2026-05-09-003-install-amneziawg`.
- [ ] `api/src/vpn/providers/amnezia-wg.provider.ts` + `agent/src/vpn/amnezia-wg.ts`.
- [ ] UI поддержка AmneziaWG в модалках.
- [ ] Smoke test.

### Фаза 3 — Polish (по факту)

- [ ] Auto-check SNI cron + push-нотификация.
- [ ] Ротация ключей / SNI из UI.
- [ ] Регенерация sub-токена.

### Фаза 4 (потом, не в скоупе MVP)

- [ ] Hysteria2 / TUIC v5 / sing-box-fallback на 443.
- [ ] Multi-server subscription (load balancing на клиенте).

---

## 15. Edge cases и риски

1. **Конфликт порта** — порт уже занят (nginx/php-fpm/другой VPN). Перед деплоем агент делает `ss -ltnp | grep :PORT` (TCP) / `ss -lunp | grep :PORT` (UDP) → если занято, возвращает ошибку до systemctl start.

2. **AmneziaWG kernel module** — не на всех хостингах разрешено грузить kernel-модули (контейнерные VPS, OpenVZ). Если `modprobe amneziawg` падает — install-миграция помечает `kernelModuleAvailable=false` в `Server.metadata`, UI блокирует кнопку «Развернуть AmneziaWG» с tooltip «не поддерживается на этом сервере». **Fallback userspace-реализация (`amneziawg-go`) — не в MVP**, потом.

3. **NAT с одним IP и сайтами на 443** — VPN на 443 невозможен, нужен другой порт. UI это и предлагает.

4. **SNI-маска внезапно умерла** — auto-check ловит, push админу, админ ротирует через UI. **Не делаем автоматическую ротацию** — это рискованно (что если все маски в списке по SNIA-цензуре одновременно недоступны — заDDoS-нем сами себя).

5. **Backup/restore VPN-конфигов** — `state/vpn/` НЕ должен попадать в git. Должен попадать в `state/data/snapshots/` (через существующий `make snapshot`). Добавить в snapshot-скрипт.

6. **Ротация серверного приватного ключа Reality** — все юзеры получат новый `pbk` в URL. Но **UUID юзеров не меняются** → достаточно перезагрузить subscription в клиенте. Кнопка «Ротировать ключи» в UI выводит warning.

7. **Удаление сервиса с активными юзерами** — confirm-modal с пересчётом «У вас N активных юзеров, они потеряют доступ. Продолжить?».

8. **Релиз `make update`** — миграции `2026-05-09-001/002/003` запускаются автоматически при апдейте панели. Установка Xray скачивает свежий бинарник от GitHub — нужен интернет на сервере панели (он там и так есть).

9. **Юридический warning в UI** — на странице VPN маленьким шрифтом: *«Вы используете VPN исключительно для своих личных нужд. За использование сервиса третьими лицами ответственность лежит на администраторе сервера»*. Без рекламы обхода блокировок.

---

## 16. Migration rule check (HARD)

Согласно `SOUL.md` § Migration rules, нужны:

- ✅ **Prisma:** меняем `schema.prisma` → `npx prisma migrate dev --name vpn-management`.
- ✅ **Системные миграции:**
  - `2026-05-09-001-vpn-secret-bootstrap` — создаёт `.vpn-key` если нет.
  - `2026-05-09-002-install-xray` — устанавливает Xray.
  - `2026-05-09-003-install-amneziawg` — устанавливает AmneziaWG (отдельная миграция, чтобы можно было откатить независимо).
- ✅ **Env-переменные:** `VPN_SECRET_KEY` опциональная (есть fallback на файл) — миграция дописывает дефолт в `state/.env` НЕ нужна, файл сам создастся.
- ✅ **Идемпотентность** — все миграции проверяют состояние перед изменением.

---

## 17. Acceptance criteria

MVP считается готовым когда:

1. Из UI развёртывается VLESS+Reality на тестовом сервере одним кликом, со своим портом, со своим SNI.
2. Из UI развёртывается AmneziaWG на тестовом сервере одним кликом, со своим портом.
3. Создаётся VPN-юзер, выдаётся QR-код, его сканит **Streisand на iOS** → коннект работает, трафик идёт.
4. Создаётся AmneziaWG-юзер, выдаётся QR → сканит **Amnezia на iOS** → коннект работает.
5. Subscription URL подставляется в **Streisand** → подтягивает все VLESS-юзеры со всех серверов.
6. Удаление юзера → клиент через 5 сек теряет коннект.
7. Удаление сервиса → systemd unit удалён, порт закрыт, БД-запись удалена.
8. После `make update` всё работает после перезагрузки сервера (systemd unit'ы поднимаются автоматом).
9. Приватные ключи в БД зашифрованы (визуально проверка `sqlite3 meowbox.db "SELECT configBlob FROM VpnService"` → base64 нечитаемый).

---

**Конец спеки.**
