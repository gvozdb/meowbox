import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { readFile, writeFile, rename, mkdir, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { type Dispatcher } from 'undici';
import { RemoteRegistryService } from '../federation/remote-registry.service';
import {
  createValidatedTlsDispatcher,
  PinnedFederationDispatcher,
} from '../federation/pinned-dispatcher';
import {
  parseFederationOrigin,
  resolveFederationOrigin,
} from '../federation/endpoint-normalizer';

export interface ServerConfig {
  id: string;
  name: string;
  url: string; // e.g. "http://10.0.0.5:3000"
  token: string; // proxy auth token
}

export interface ServerInfo extends ServerConfig {
  online: boolean;
  /** Текущая версия панели на удалённом сервере (например `v0.3.0`). */
  version?: string;
  /** Latest release с GitHub, как видит сам удалённый сервер (может быть null если приватный repo и нет токена). */
  latestVersion?: string | null;
  /** Доступно ли обновление (latest > current на удалённом). */
  hasUpdate?: boolean;
  /** Последняя успешная проверка статуса (ISO). */
  lastCheckedAt?: string;
  /** Если последняя проверка упала — причина. */
  lastError?: string;
  federation?: boolean;
  protocolVersion?: number | null;
  activationMode?: string;
  capabilityState?: string;
  reasonCode?: string;
  registryGeneration?: number;
  fleetUpdateReady?: boolean;
  fleetUpdateReason?: string | null;
}

const DATA_DIR = join(process.cwd(), '..', 'data');
const SERVERS_FILE = join(DATA_DIR, 'servers.json');
const LEGACY_BROWSER_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
]);

@Injectable()
export class ProxyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ProxyService');
  private servers: ServerConfig[] = [];
  private readonly legacyDispatchers = new Map<string, PinnedFederationDispatcher>();

  constructor(
    private readonly config: ConfigService,
    private readonly remoteRegistry: RemoteRegistryService,
  ) {}

  async onModuleInit() {
    await this.loadServers();
  }

  async onModuleDestroy() {
    const dispatchers = [...this.legacyDispatchers.values()];
    this.legacyDispatchers.clear();
    await Promise.allSettled(dispatchers.map(({ close }) => close()));
  }

  private async loadServers() {
    const authority = await this.remoteRegistry.authority();
    if (authority === 'DB' || authority === 'FROZEN') {
      this.servers = await this.remoteRegistry.getLegacyServersFromDb();
      this.logger.log(
        `Loaded ${this.servers.length} server(s) from DB registry (${authority.toLowerCase()})`,
      );
      return;
    }

    // Ensure data directory exists
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }

    // Try to read from JSON file
    if (existsSync(SERVERS_FILE)) {
      try {
        const raw = await readFile(SERVERS_FILE, 'utf-8');
        this.servers = JSON.parse(raw);
        this.logger.log(
          `Loaded ${this.servers.length} server(s) from ${SERVERS_FILE}`,
        );
        return;
      } catch {
        this.logger.warn('Failed to parse servers.json, checking env fallback');
      }
    }

    // Fallback: migrate from SERVERS env var
    const envRaw = this.config.get<string>('SERVERS', '');
    if (envRaw) {
      try {
        this.servers = JSON.parse(envRaw);
        this.logger.log(
          `Migrated ${this.servers.length} server(s) from SERVERS env to JSON`,
        );
        await this.saveServers();
        return;
      } catch {
        this.logger.warn('Failed to parse SERVERS env');
      }
    }

    // No servers configured — create empty file
    this.servers = [];
    await this.saveServers();
    this.logger.log('Created empty servers.json');
  }

  private async saveServers() {
    // Atomic write: tmp file → rename. chmod 600 ОБЯЗАТЕЛЬНО — файл содержит
    // PROXY_TOKEN'ы всех slave-серверов в plaintext. Любой локальный юзер не
    // должен мочь их прочитать.
    const tmp = SERVERS_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(this.servers, null, 2), 'utf-8');
    await chmod(tmp, 0o600);
    await rename(tmp, SERVERS_FILE);
  }

  getServers(): ServerConfig[] {
    return this.servers;
  }

  getServer(id: string): ServerConfig | undefined {
    return this.servers.find((s) => s.id === id);
  }

  private getFetchDispatcher(server: ServerConfig): Dispatcher {
    const origin = parseFederationOrigin(server.url).origin;
    const existing = this.legacyDispatchers.get(origin);
    if (existing) return existing.dispatcher;
    const created = createValidatedTlsDispatcher(origin, { connectTimeoutMs: 5_000 });
    this.legacyDispatchers.set(origin, created);
    return created.dispatcher;
  }

  private async validateLegacyOrigin(input: string): Promise<string> {
    const origin = parseFederationOrigin(input);
    await resolveFederationOrigin(origin);
    return origin.origin;
  }

  private async clearLegacyDispatchers(): Promise<void> {
    const dispatchers = [...this.legacyDispatchers.values()];
    this.legacyDispatchers.clear();
    await Promise.allSettled(dispatchers.map(({ close }) => close()));
  }

  private assertNoLegacyRedirect(response: Response): void {
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel();
      throw new Error('Legacy target redirect refused');
    }
  }

  async addServer(
    data: Omit<ServerConfig, 'id'> & { id?: string },
  ): Promise<ServerConfig> {
    if (this.servers.some((s) => s.name === data.name)) {
      throw new BadRequestException(`Server "${data.name}" already exists`);
    }

    const normalizedOrigin = await this.validateLegacyOrigin(data.url);

    if (await this.remoteRegistry.authority() !== 'JSON') {
      const created = await this.remoteRegistry.addLegacyServer({
        id: data.id,
        name: data.name,
        url: normalizedOrigin,
        token: data.token,
      });
      this.servers = await this.remoteRegistry.getLegacyServersFromDb();
      return created;
    }

    const server: ServerConfig = {
      id: data.id || randomUUID().slice(0, 8),
      name: data.name,
      url: normalizedOrigin,
      token: data.token,
    };

    this.servers.push(server);
    await this.saveServers();
    this.logger.log(`Added server "${server.name}" (${server.id})`);
    return server;
  }

  async updateServer(
    id: string,
    data: Partial<Omit<ServerConfig, 'id'>>,
  ): Promise<ServerConfig> {
    const idx = this.servers.findIndex((s) => s.id === id);
    if (idx === -1) {
      throw new NotFoundException(`Server "${id}" not found`);
    }

    if (data.url !== undefined) {
      data.url = await this.validateLegacyOrigin(data.url);
    }

    if (await this.remoteRegistry.authority() !== 'JSON') {
      const updated = await this.remoteRegistry.updateLegacyServer(id, {
        ...(data.name === undefined ? {} : { name: data.name }),
        ...(data.url === undefined ? {} : { url: data.url }),
        ...(data.token === undefined ? {} : { token: data.token }),
      });
      this.servers = await this.remoteRegistry.getLegacyServersFromDb();
      this.statusCache.delete(id);
      await this.clearLegacyDispatchers();
      return updated;
    }

    if (data.name !== undefined) this.servers[idx].name = data.name;
    if (data.url !== undefined)
      this.servers[idx].url = data.url;
    if (data.token !== undefined) this.servers[idx].token = data.token;

    await this.saveServers();
    // URL/токен поменялись — статус мог стать невалидным. Инвалидируем кеш.
    this.statusCache.delete(id);
    await this.clearLegacyDispatchers();
    this.logger.log(`Updated server "${this.servers[idx].name}" (${id})`);
    return this.servers[idx];
  }

  async removeServer(id: string): Promise<void> {
    if (await this.remoteRegistry.authority() !== 'JSON') {
      await this.remoteRegistry.removeLegacyServer(id);
      this.servers = await this.remoteRegistry.getLegacyServersFromDb();
      this.statusCache.delete(id);
      return;
    }
    const idx = this.servers.findIndex((s) => s.id === id);
    if (idx === -1) {
      throw new NotFoundException(`Server "${id}" not found`);
    }

    const name = this.servers[idx].name;
    this.servers.splice(idx, 1);
    await this.saveServers();
    this.statusCache.delete(id);
    this.logger.log(`Removed server "${name}" (${id})`);
  }

  private static readonly LEGACY_REQUEST_TIMEOUT_MS = 30_000;

  /**
   * JSON-only прокси — для внутренних вызовов мастера (pingServer, updateBulk).
   * Тело сериализуется как JSON, ответ парсится как JSON. НЕ использовать
   * для пользовательских запросов через /proxy/:serverId/* — там нужен
   * raw pass-through (см. proxyRaw).
   *
   * @param timeoutOverride — явный таймаут для узкого control-plane вызова.
   */
  async proxyRequest(
    server: ServerConfig,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    timeoutOverride?: number,
  ): Promise<{ status: number; data: unknown }> {
    const url = `${server.url}/api${path}`;

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Proxy-Token': server.token,
      ...headers,
    };

    // Remove auth headers that belong to the main server
    delete reqHeaders['authorization'];
    delete reqHeaders['Authorization'];

    const timeoutMs = timeoutOverride ?? ProxyService.LEGACY_REQUEST_TIMEOUT_MS;

    const fetchOptions: RequestInit = {
      method,
      headers: reqHeaders,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    };
    (fetchOptions as RequestInit & { dispatcher: Dispatcher }).dispatcher = this.getFetchDispatcher(server);

    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    this.assertNoLegacyRedirect(response);
    const data = await response.json().catch(() => null);

    return { status: response.status, data };
  }

  /**
   * Низкоуровневый pass-through для пользовательских запросов через UI.
   * Сохраняет Content-Type/headers/тело как Buffer, возвращает Response с
   * читаемым потоком тела — контроллер стримит его клиенту через res.pipe.
   *
   * Это критично для:
   *   - multipart/form-data (загрузка файлов)
   *   - бинарных скачиваний (бэкап-экспорты, дампы БД, файлы из /files)
   *   - произвольных text/* ответов
   *
   * Никаких JSON.stringify/response.json — байты идут как есть.
   *
   * Этот адаптер обслуживает только legacy-static-v0 allowlist. Федерация v1
   * использует action-specific connect/header/idle budgets и durable Operation
   * вместо path-prefix total timeout.
   */
  async proxyRaw(
    server: ServerConfig,
    method: string,
    pathWithQuery: string,
    headers: Record<string, string>,
    body?: Buffer,
    timeoutOverride?: number,
  ): Promise<Response> {
    const url = `${server.url}/api${pathWithQuery}`;

    // Копируем входящие заголовки, выбрасываем те, что не должны проксироваться:
    // - host/connection — относятся к master, не к slave
    // - authorization — это JWT мастера, slave не должен видеть
    // - cookie — те же соображения, plus сессии у slave свои
    // - content-length — пересчитается автоматически из тела
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (LEGACY_BROWSER_HEADERS.has(lk)) reqHeaders[lk] = v;
    }
    reqHeaders['X-Proxy-Token'] = server.token;
    // Убираем accept-encoding: пусть undici возвращает ответ как есть
    // (без gzip/br), иначе придётся декодить перед стримом клиенту.
    delete reqHeaders['accept-encoding'];
    delete reqHeaders['Accept-Encoding'];

    const timeoutMs = timeoutOverride ?? ProxyService.LEGACY_REQUEST_TIMEOUT_MS;

    const fetchOptions: RequestInit = {
      method,
      headers: reqHeaders,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      // duplex: 'half' нужен для streaming body, но мы передаём целиком Buffer
      // (контроллер уже собрал raw body), так что это не критично.
    };
    (fetchOptions as RequestInit & { dispatcher: Dispatcher }).dispatcher = this.getFetchDispatcher(server);

    if (body && body.length > 0 && method !== 'GET' && method !== 'HEAD') {
      // node-fetch принимает Buffer — но lib.dom типы fetch BodyInit не
      // включают node Buffer. Каст через unknown — runtime-совместимо.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fetchOptions as any).body = body;
    }

    const response = await fetch(url, fetchOptions);
    this.assertNoLegacyRedirect(response);
    return response;
  }

  /**
   * Ping a server to check if it's online + get version.
   * Использует /admin/update/version — лёгкий endpoint, который возвращает
   * current/latest/hasUpdate (читает VERSION файл и кешированный latest).
   */
  async pingServer(
    server: ServerConfig,
  ): Promise<{
    online: boolean;
    version?: string;
    latestVersion?: string | null;
    hasUpdate?: boolean;
    lastError?: string;
  }> {
    try {
      const { status, data } = await this.proxyRequest(
        server,
        'GET',
        '/admin/update/version',
        undefined,
        undefined,
        5_000, // ping должен быть быстрым
      );
      if (status === 200 && data) {
        const payload = (data as { data?: { current?: string; latest?: string | null; hasUpdate?: boolean } }).data;
        return {
          online: true,
          version: payload?.current,
          latestVersion: payload?.latest ?? null,
          hasUpdate: !!payload?.hasUpdate,
        };
      }
      return { online: false, lastError: `HTTP ${status}` };
    } catch (err) {
      return { online: false, lastError: (err as Error).message };
    }
  }

  /**
   * In-memory кеш статуса серверов. Обновляется фоновым healthcheck'ом
   * (см. ProxyHealthcheckService) и при ручных кликах "Обновить".
   * Карта по serverId.
   */
  private statusCache = new Map<string, Omit<ServerInfo, keyof ServerConfig>>();

  /**
   * Прокладка для healthcheck/ручного refresh.
   * Пингует все серверы параллельно, обновляет statusCache, возвращает результат.
   */
  async refreshStatuses(): Promise<ServerInfo[]> {
    const results = await Promise.allSettled(
      this.servers.map(async (s) => {
        const ping = await this.pingServer(s);
        const status = {
          online: ping.online,
          version: ping.version,
          latestVersion: ping.latestVersion,
          hasUpdate: ping.hasUpdate,
          lastError: ping.lastError,
          lastCheckedAt: new Date().toISOString(),
        };
        this.statusCache.set(s.id, status);
        return { ...s, ...status, token: '***' } as ServerInfo;
      }),
    );

    const legacy = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const fallback = {
        online: false,
        lastError: (r.reason as Error)?.message ?? 'unknown',
        lastCheckedAt: new Date().toISOString(),
      };
      this.statusCache.set(this.servers[i].id, fallback);
      return { ...this.servers[i], ...fallback, token: '***' } as ServerInfo;
    });
    return [...legacy, ...await this.federatedServerInfo()];
  }

  /**
   * Возвращает текущий снапшот серверов из кеша. Если кеш пуст для какого-то
   * сервера — пингует его. Используется в /api/servers (быстрый ответ).
   */
  async getServersWithStatus(): Promise<ServerInfo[]> {
    const missing = this.servers.filter((s) => !this.statusCache.has(s.id));
    if (missing.length > 0) {
      // Пингуем только те, что отсутствуют в кеше — фоновая задача наполнит
      // остальные. Это снимает load с /api/servers при добавлении нового сервера.
      await Promise.allSettled(
        missing.map(async (s) => {
          const ping = await this.pingServer(s);
          this.statusCache.set(s.id, {
            online: ping.online,
            version: ping.version,
            latestVersion: ping.latestVersion,
            hasUpdate: ping.hasUpdate,
            lastError: ping.lastError,
            lastCheckedAt: new Date().toISOString(),
          });
        }),
      );
    }

    const legacy = this.servers.map((s) => {
      const status = this.statusCache.get(s.id) ?? { online: false };
      return { ...s, ...status, token: '***' } as ServerInfo;
    });
    return [...legacy, ...await this.federatedServerInfo()];
  }

  private async federatedServerInfo(): Promise<ServerInfo[]> {
    const authority = await this.remoteRegistry.authority();
    if (authority === 'JSON') return [];
    const summaries = await this.remoteRegistry.listFederatedServerSummaries();
    return summaries.map((summary) => ({
      id: summary.id,
      name: summary.name,
      url: summary.publicOrigin,
      token: '***',
      online: summary.online,
      version: summary.version,
      lastCheckedAt: summary.lastCheckedAt,
      lastError: summary.online ? undefined : summary.reasonCode,
      federation: true,
      protocolVersion: summary.protocolVersion,
      activationMode: summary.activationMode,
      capabilityState: summary.capabilityState,
      reasonCode: summary.reasonCode,
      registryGeneration: summary.registryGeneration,
      fleetUpdateReady: summary.fleetUpdateReady,
      fleetUpdateReason: summary.fleetUpdateReason,
    }));
  }

  /** Очищает кеш статуса конкретного сервера (после edit/remove). */
  invalidateStatus(serverId: string): void {
    this.statusCache.delete(serverId);
  }
}
