import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { type Dispatcher } from 'undici';
import {
  LegacyServerRecord,
  parseLegacyRegistry,
  renderLegacyRegistry,
  validateLegacyServerRecord,
} from '../federation/legacy-registry';
import { RemoteRegistryService } from '../federation/remote-registry.service';
import {
  createPinnedFederationDispatcher,
  createValidatedTlsDispatcher,
  inspectLegacySelfSignedCertificate,
  PinnedFederationDispatcher,
  validateLegacySelfSignedCertificate,
} from '../federation/pinned-dispatcher';
import {
  parseFederationOrigin,
  resolveFederationOrigin,
} from '../federation/endpoint-normalizer';
import { discoverLegacySelfSignedCertificate } from './legacy-tls-trust';

export interface ServerConfig extends LegacyServerRecord {}

type ServerConfigUpdate = Omit<Partial<Omit<ServerConfig, 'id'>>, 'tlsCaCertificatePem'> & {
  tlsCaCertificatePem?: string | null;
};

export interface ServerInfo {
  id: string;
  name: string;
  url: string;
  token: string;
  tlsSpkiSha256?: string;
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

export type LegacyProxyTransportErrorCode =
  | 'LEGACY_TLS_PIN_REQUIRED'
  | 'LEGACY_TLS_PIN_MISMATCH'
  | 'LEGACY_TLS_HOSTNAME_MISMATCH'
  | 'LEGACY_TLS_CERT_INVALID'
  | 'LEGACY_UPSTREAM_UNREACHABLE';

export class LegacyProxyTransportError extends Error {
  constructor(
    readonly code: LegacyProxyTransportErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'LegacyProxyTransportError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function errorChain(error: unknown): Array<{ code?: unknown; message?: unknown }> {
  const chain: Array<{ code?: unknown; message?: unknown }> = [];
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') break;
    const item = current as { code?: unknown; message?: unknown; cause?: unknown };
    chain.push(item);
    current = item.cause;
  }
  return chain;
}

export function normalizeLegacyProxyTransportError(
  error: unknown,
  hasPinnedTrust = false,
): LegacyProxyTransportError {
  if (error instanceof LegacyProxyTransportError) return error;
  const chain = errorChain(error);
  const codes = new Set(chain.map(({ code }) => code).filter((code): code is string => typeof code === 'string'));
  const messages = chain.map(({ message }) => typeof message === 'string' ? message : '').join('\n');

  if (codes.has('DEPTH_ZERO_SELF_SIGNED_CERT') || codes.has('SELF_SIGNED_CERT_IN_CHAIN') ||
      codes.has('UNABLE_TO_VERIFY_LEAF_SIGNATURE') || codes.has('UNABLE_TO_GET_ISSUER_CERT_LOCALLY') ||
      codes.has('CERT_UNTRUSTED')) {
    if (hasPinnedTrust) {
      return new LegacyProxyTransportError(
        'LEGACY_TLS_PIN_MISMATCH',
        'Configured TLS certificate does not match the server certificate',
        error,
      );
    }
    return new LegacyProxyTransportError(
      'LEGACY_TLS_PIN_REQUIRED',
      'Self-signed TLS certificate requires automatic trust bootstrap',
      error,
    );
  }
  if (/SPKI pin mismatch/i.test(messages)) {
    return new LegacyProxyTransportError(
      'LEGACY_TLS_PIN_MISMATCH',
      'Configured TLS certificate does not match the server certificate',
      error,
    );
  }
  if (codes.has('ERR_TLS_CERT_ALTNAME_INVALID') || /hostname\/IP does not match/i.test(messages)) {
    return new LegacyProxyTransportError(
      'LEGACY_TLS_HOSTNAME_MISMATCH',
      'TLS certificate does not match the configured server host',
      error,
    );
  }
  if (codes.has('CERT_HAS_EXPIRED') || codes.has('CERT_NOT_YET_VALID') ||
      /validity period/i.test(messages) || /must be self-signed/i.test(messages)) {
    return new LegacyProxyTransportError(
      'LEGACY_TLS_CERT_INVALID',
      'Pinned TLS certificate is invalid or expired',
      error,
    );
  }
  return new LegacyProxyTransportError(
    'LEGACY_UPSTREAM_UNREACHABLE',
    'Legacy server is unreachable',
    error,
  );
}

@Injectable()
export class ProxyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ProxyService');
  private servers: ServerConfig[] = [];
  private readonly legacyDispatchers = new Map<string, PinnedFederationDispatcher>();
  private readonly legacyTrustBootstraps = new Map<string, Promise<ServerConfig>>();

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
        this.servers = parseLegacyRegistry(raw);
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
        this.servers = parseLegacyRegistry(envRaw);
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
    await writeFile(tmp, renderLegacyRegistry(this.servers), 'utf-8');
    await chmod(tmp, 0o600);
    await rename(tmp, SERVERS_FILE);
  }

  getServers(): ServerConfig[] {
    return this.servers;
  }

  getServer(id: string): ServerConfig | undefined {
    return this.servers.find((s) => s.id === id);
  }

  publicServerConfig(server: ServerConfig): Omit<ServerInfo, 'online'> {
    const publicServer = {
      id: server.id,
      name: server.name,
      url: server.url,
      token: '***',
    };
    if (!server.tlsCaCertificatePem) return publicServer;
    const trust = inspectLegacySelfSignedCertificate(server.url, server.tlsCaCertificatePem);
    return { ...publicServer, tlsSpkiSha256: trust.spkiSha256 };
  }

  private getFetchDispatcher(server: ServerConfig): Dispatcher {
    try {
      const origin = parseFederationOrigin(server.url).origin;
      const trust = server.tlsCaCertificatePem
        ? validateLegacySelfSignedCertificate(origin, server.tlsCaCertificatePem)
        : null;
      const certificateDigest = trust
        ? createHash('sha256').update(trust.caCertificatePem).digest('base64url')
        : '';
      const key = `${origin}\0${trust?.spkiSha256 ?? ''}\0${certificateDigest}`;
      const existing = this.legacyDispatchers.get(key);
      if (existing) return existing.dispatcher;
      const created = trust
        ? createPinnedFederationDispatcher(origin, {
          spkiSha256: trust.spkiSha256,
          ca: trust.caCertificatePem,
          connectTimeoutMs: 5_000,
        })
        : createValidatedTlsDispatcher(origin, { connectTimeoutMs: 5_000 });
      this.legacyDispatchers.set(key, created);
      return created.dispatcher;
    } catch (error) {
      throw normalizeLegacyProxyTransportError(error, !!server.tlsCaCertificatePem);
    }
  }

  private async validateLegacyOrigin(
    input: string,
    tlsCaCertificatePem?: string,
  ): Promise<string> {
    try {
      const origin = parseFederationOrigin(input);
      await resolveFederationOrigin(origin);
      if (tlsCaCertificatePem) {
        validateLegacySelfSignedCertificate(origin.origin, tlsCaCertificatePem);
      }
      return origin.origin;
    } catch (error) {
      const normalized = normalizeLegacyProxyTransportError(error);
      throw new BadRequestException(normalized.message, { cause: error });
    }
  }

  private async clearLegacyDispatchers(): Promise<void> {
    const dispatchers = [...this.legacyDispatchers.values()];
    this.legacyDispatchers.clear();
    await Promise.allSettled(dispatchers.map(({ close }) => close()));
  }

  private async bindLegacySelfSignedTrust(
    server: ServerConfig,
    replaceExisting = false,
  ): Promise<ServerConfig> {
    const inProgress = this.legacyTrustBootstraps.get(server.id);
    if (inProgress) return inProgress;

    const bootstrap = (async () => {
      const current = this.getServer(server.id);
      if (!current) throw new NotFoundException(`Server "${server.id}" not found`);
      if (current.tlsCaCertificatePem && !replaceExisting) return current;

      const expectedOrigin = parseFederationOrigin(current.url).origin;
      const trust = await discoverLegacySelfSignedCertificate(expectedOrigin);
      const latest = this.getServer(server.id);
      if (!latest) throw new NotFoundException(`Server "${server.id}" not found`);
      if (parseFederationOrigin(latest.url).origin !== expectedOrigin) {
        throw new LegacyProxyTransportError(
          'LEGACY_TLS_PIN_MISMATCH',
          'Legacy server URL changed during TLS trust bootstrap',
        );
      }
      if (latest.tlsCaCertificatePem && !replaceExisting) return latest;

      const updated = await this.updateServer(server.id, {
        tlsCaCertificatePem: trust.caCertificatePem,
      });
      this.logger.log(`Pinned self-signed TLS certificate for "${updated.name}" (${updated.id})`);
      return updated;
    })();

    this.legacyTrustBootstraps.set(server.id, bootstrap);
    try {
      return await bootstrap;
    } finally {
      if (this.legacyTrustBootstraps.get(server.id) === bootstrap) {
        this.legacyTrustBootstraps.delete(server.id);
      }
    }
  }

  private assertNoLegacyRedirect(response: Response): void {
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel();
      throw new Error('Legacy target redirect refused');
    }
  }

  private async fetchLegacy(
    server: ServerConfig,
    url: string,
    options: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(url, options);
    } catch (error) {
      const normalized = normalizeLegacyProxyTransportError(
        error,
        !!server.tlsCaCertificatePem,
      );
      if (
        normalized.code !== 'LEGACY_TLS_PIN_REQUIRED' ||
        server.tlsCaCertificatePem
      ) throw normalized;

      try {
        const trusted = await this.bindLegacySelfSignedTrust(server);
        const retryOptions = { ...options };
        (retryOptions as RequestInit & { dispatcher: Dispatcher }).dispatcher =
          this.getFetchDispatcher(trusted);
        return await fetch(url, retryOptions);
      } catch (retryError) {
        throw normalizeLegacyProxyTransportError(retryError, true);
      }
    }
  }

  async refreshLegacyTlsTrust(id: string): Promise<ServerConfig> {
    const server = this.getServer(id);
    if (!server) throw new NotFoundException(`Server "${id}" not found`);
    return this.bindLegacySelfSignedTrust(server, true);
  }

  async addServer(
    data: Omit<ServerConfig, 'id'> & { id?: string },
  ): Promise<ServerConfig> {
    if (this.servers.some((s) => s.name === data.name)) {
      throw new BadRequestException(`Server "${data.name}" already exists`);
    }

    const normalizedOrigin = await this.validateLegacyOrigin(
      data.url,
      data.tlsCaCertificatePem,
    );
    const server = validateLegacyServerRecord({
      id: data.id || randomUUID().slice(0, 8),
      name: data.name,
      url: normalizedOrigin,
      token: data.token,
      ...(data.tlsCaCertificatePem === undefined
        ? {}
        : { tlsCaCertificatePem: data.tlsCaCertificatePem }),
    });

    if (await this.remoteRegistry.authority() !== 'JSON') {
      const created = await this.remoteRegistry.addLegacyServer(server);
      this.servers = await this.remoteRegistry.getLegacyServersFromDb();
      return created;
    }

    this.servers.push(server);
    await this.saveServers();
    this.logger.log(`Added server "${server.name}" (${server.id})`);
    return server;
  }

  async updateServer(
    id: string,
    data: ServerConfigUpdate,
  ): Promise<ServerConfig> {
    const idx = this.servers.findIndex((s) => s.id === id);
    if (idx === -1) {
      throw new NotFoundException(`Server "${id}" not found`);
    }

    const current = this.servers[idx];
    const normalizedUrl = data.url === undefined
      ? current.url
      : await this.validateLegacyOrigin(data.url);
    const candidate: Record<string, unknown> = {
      ...current,
      ...data,
      id,
      url: normalizedUrl,
    };
    if (normalizedUrl !== current.url) delete candidate.tlsCaCertificatePem;
    if (data.tlsCaCertificatePem === null) delete candidate.tlsCaCertificatePem;
    const next = validateLegacyServerRecord(candidate);
    if (data.tlsCaCertificatePem !== undefined) {
      next.url = await this.validateLegacyOrigin(next.url, next.tlsCaCertificatePem);
    }

    if (await this.remoteRegistry.authority() !== 'JSON') {
      const updated = await this.remoteRegistry.updateLegacyServer(id, {
        ...(data.name === undefined ? {} : { name: data.name }),
        ...(data.url === undefined ? {} : { url: next.url }),
        ...(data.token === undefined ? {} : { token: data.token }),
        ...(normalizedUrl !== current.url
          ? { tlsCaCertificatePem: null }
          : data.tlsCaCertificatePem === undefined
            ? {}
            : { tlsCaCertificatePem: data.tlsCaCertificatePem }),
      });
      this.servers = await this.remoteRegistry.getLegacyServersFromDb();
      this.statusCache.delete(id);
      await this.clearLegacyDispatchers();
      return updated;
    }

    this.servers[idx] = next;

    await this.saveServers();
    // URL/токен поменялись — статус мог стать невалидным. Инвалидируем кеш.
    this.statusCache.delete(id);
    await this.clearLegacyDispatchers();
    this.logger.log(`Updated server "${next.name}" (${id})`);
    return next;
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
    (fetchOptions as RequestInit & { dispatcher: Dispatcher }).dispatcher =
      this.getFetchDispatcher(server);

    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await this.fetchLegacy(server, url, fetchOptions);
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
    (fetchOptions as RequestInit & { dispatcher: Dispatcher }).dispatcher =
      this.getFetchDispatcher(server);

    if (body && body.length > 0 && method !== 'GET' && method !== 'HEAD') {
      // node-fetch принимает Buffer — но lib.dom типы fetch BodyInit не
      // включают node Buffer. Каст через unknown — runtime-совместимо.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fetchOptions as any).body = body;
    }

    const response = await this.fetchLegacy(server, url, fetchOptions);
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
      const error = normalizeLegacyProxyTransportError(err);
      return { online: false, lastError: error.code };
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
        return { ...this.publicServerConfig(s), ...status } as ServerInfo;
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
      return {
        ...this.publicServerConfig(this.servers[i]),
        ...fallback,
      } as ServerInfo;
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
      return { ...this.publicServerConfig(s), ...status } as ServerInfo;
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
