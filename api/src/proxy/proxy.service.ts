import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { assertPublicHttpUrl } from '../common/validators/safe-url';

export interface ServerConfig {
  id: string;
  name: string;
  url: string; // e.g. "http://10.0.0.5:3000"
  token: string; // proxy auth token
}

export interface ServerInfo extends ServerConfig {
  online: boolean;
  version?: string;
}

const DATA_DIR = join(process.cwd(), '..', 'data');
const SERVERS_FILE = join(DATA_DIR, 'servers.json');

@Injectable()
export class ProxyService implements OnModuleInit {
  private readonly logger = new Logger('ProxyService');
  private servers: ServerConfig[] = [];

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    await this.loadServers();
  }

  private async loadServers() {
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
    // Atomic write: tmp file → rename
    const tmp = SERVERS_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(this.servers, null, 2), 'utf-8');
    await rename(tmp, SERVERS_FILE);
  }

  getServers(): ServerConfig[] {
    return this.servers;
  }

  getServer(id: string): ServerConfig | undefined {
    return this.servers.find((s) => s.id === id);
  }

  async addServer(
    data: Omit<ServerConfig, 'id'> & { id?: string },
  ): Promise<ServerConfig> {
    if (this.servers.some((s) => s.name === data.name)) {
      throw new BadRequestException(`Server "${data.name}" already exists`);
    }

    // Runtime-проверка URL: блокируем 127.0.0.1/AWS IMDS/private-net.
    // DTO уже ограничил https:// на уровне формата, но это допол. слой:
    // proxy-фичу легко превратить в SSRF-гаджет (forward-any-request).
    await assertPublicHttpUrl(data.url, { protocols: ['https:'] });

    const server: ServerConfig = {
      id: data.id || randomUUID().slice(0, 8),
      name: data.name,
      url: data.url.replace(/\/+$/, ''), // strip trailing slash
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
      // Allow http для только что провижнящихся серверов (до выпуска TLS).
      // Поверх — DTO контроллера уже требует https для добавления вручную,
      // так что http-путь остаётся только внутреннему provision.
      await assertPublicHttpUrl(data.url, { protocols: ['http:', 'https:'] });
    }

    if (data.name !== undefined) this.servers[idx].name = data.name;
    if (data.url !== undefined)
      this.servers[idx].url = data.url.replace(/\/+$/, '');
    if (data.token !== undefined) this.servers[idx].token = data.token;

    await this.saveServers();
    this.logger.log(`Updated server "${this.servers[idx].name}" (${id})`);
    return this.servers[idx];
  }

  async removeServer(id: string): Promise<void> {
    const idx = this.servers.findIndex((s) => s.id === id);
    if (idx === -1) {
      throw new NotFoundException(`Server "${id}" not found`);
    }

    const name = this.servers[idx].name;
    this.servers.splice(idx, 1);
    await this.saveServers();
    this.logger.log(`Removed server "${name}" (${id})`);
  }

  /**
   * Proxy an HTTP request to a remote server.
   */
  async proxyRequest(
    server: ServerConfig,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
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

    const fetchOptions: RequestInit = {
      method,
      headers: reqHeaders,
      signal: AbortSignal.timeout(30_000),
    };

    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json().catch(() => null);

    return { status: response.status, data };
  }

  /**
   * Ping a server to check if it's online + get version.
   */
  async pingServer(
    server: ServerConfig,
  ): Promise<{ online: boolean; version?: string }> {
    try {
      const { status, data } = await this.proxyRequest(
        server,
        'GET',
        '/system/versions',
      );
      if (status === 200 && data) {
        const d = (data as { data?: Record<string, unknown> }).data;
        return {
          online: true,
          version: d?.meowbox as string | undefined,
        };
      }
      return { online: false };
    } catch {
      return { online: false };
    }
  }

  /**
   * Get all servers with online status.
   */
  async getServersWithStatus(): Promise<ServerInfo[]> {
    const results = await Promise.allSettled(
      this.servers.map(async (s) => {
        const { online, version } = await this.pingServer(s);
        return { ...s, online, version, token: '***' } as ServerInfo;
      }),
    );

    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { ...this.servers[i], online: false, token: '***' },
    );
  }
}
