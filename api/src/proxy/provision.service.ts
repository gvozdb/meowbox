import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Client } from 'ssh2';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { ProxyService } from './proxy.service';
import { isPrivateHost } from '../common/validators/safe-url';

/**
 * Конфигурируемый URL Git-репозитория и путь временного install-скрипта.
 * Дефолт — публичный GitHub, но на изолированных сетях (self-hosted Gitea
 * или зеркало) можно переопределить через `.env` — ничего в коде править
 * не нужно.
 */
const MEOWBOX_GIT_URL =
  process.env.MEOWBOX_GIT_URL || 'https://github.com/gvozdb/meowbox.git';
const INSTALL_SCRIPT_REMOTE_PATH =
  process.env.MEOWBOX_INSTALL_SCRIPT_PATH || '/tmp/meowbox-install.sh';
const REMOTE_API_PORT = process.env.API_PORT || '11860';

export interface ProvisionInput {
  name: string;
  host: string;
  port?: number;
  password: string;
}

export interface ProvisionResult {
  server: { id: string; name: string; url: string };
  online: boolean;
  version?: string;
  logs: string[];
}

@Injectable()
export class ProvisionService {
  private readonly logger = new Logger('ProvisionService');

  constructor(private readonly proxyService: ProxyService) {}

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const { name, host, port = 22, password } = input;
    const proxyToken = randomBytes(32).toString('hex');
    const logs: string[] = [];

    const log = (msg: string) => {
      this.logger.log(msg);
      logs.push(msg);
    };

    // Validate host — prevent SSRF / injection
    if (!/^[\w.\-:]+$/.test(host)) {
      throw new BadRequestException('Invalid host format');
    }
    // Блок локальных/приватных адресов: провижнинг чужого сервера на
    // 127.0.0.1 или AWS IMDS бессмысленен и опасен (логинимся сами в себя
    // с захардкоженным рутовым паролем).
    if (isPrivateHost(host)) {
      throw new BadRequestException(
        'Cannot provision a private, loopback, or link-local host',
      );
    }

    log(`Connecting to ${host}:${port}...`);

    // Read local install.sh
    const installScript = await readFile(
      join(process.cwd(), '..', 'install.sh'),
      'utf-8',
    );

    const conn = await this.sshConnect(host, port, password);

    try {
      // Check if meowbox is already installed
      log('Checking remote server...');
      const hasDir = await this.sshExec(
        conn,
        'test -d /opt/meowbox && echo "exists" || echo "missing"',
      );

      if (hasDir.trim() === 'missing') {
        // Clone the repository
        log('Cloning Meowbox repository...');
        await this.sshExec(
          conn,
          'apt-get update -qq && apt-get install -y -qq git',
          120_000,
        );
        await this.sshExec(
          conn,
          `git clone ${MEOWBOX_GIT_URL} /opt/meowbox`,
          120_000,
        );
        log('Repository cloned');
      } else {
        log('Meowbox directory already exists, updating...');
        await this.sshExec(conn, 'cd /opt/meowbox && git pull', 60_000);
      }

      // Upload install.sh via SFTP (use our latest version)
      log('Uploading install script...');
      await this.sftpWrite(conn, INSTALL_SCRIPT_REMOTE_PATH, installScript);
      await this.sshExec(conn, `chmod +x ${INSTALL_SCRIPT_REMOTE_PATH}`);

      // Run install with --proxy-token. Токен — hex-строка (randomBytes),
      // shell-инъекция невозможна, но кавычки оставляем layered-defense.
      log('Running install script (this may take several minutes)...');
      await this.sshExec(
        conn,
        `${INSTALL_SCRIPT_REMOTE_PATH} --proxy-token "${proxyToken}"`,
        600_000, // 10 min timeout
      );
      log('Install script completed');

      // Clean up
      await this.sshExec(conn, `rm -f ${INSTALL_SCRIPT_REMOTE_PATH}`);
    } finally {
      conn.end();
    }

    // Add server to local config. HTTP пока — серверы только что провижнились
    // и TLS ещё не готов. После выпуска TLS оператор обновит URL вручную через
    // UpdateServer (там мы требуем https://).
    // Порт настраивается через env, чтобы не переписывать код при смене default.
    const serverUrl = `http://${host}:${REMOTE_API_PORT}`;
    const server = await this.proxyService.addServer({
      name,
      url: serverUrl,
      token: proxyToken,
    });

    // Ping to verify
    log('Verifying server connection...');
    const { online, version } = await this.proxyService.pingServer(server);
    log(
      online
        ? `Server online (v${version})`
        : 'Server not responding yet — may need a moment to start',
    );

    return {
      server: { id: server.id, name: server.name, url: server.url },
      online,
      version,
      logs,
    };
  }

  private sshConnect(
    host: string,
    port: number,
    password: string,
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on('ready', () => resolve(conn));
      conn.on('error', (err) => reject(err));
      conn.connect({
        host,
        port,
        username: 'root',
        password,
        readyTimeout: 30_000,
      });
    });
  }

  private sshExec(
    conn: Client,
    command: string,
    timeout = 60_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Command timed out after ${timeout}ms`)),
        timeout,
      );

      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on('close', (code: number) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(
              new Error(
                `Command exited with code ${code}: ${stderr || stdout}`,
              ),
            );
          } else {
            resolve(stdout);
          }
        });
      });
    });
  }

  private sftpWrite(
    conn: Client,
    remotePath: string,
    content: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.writeFile(remotePath, content, (writeErr) => {
          if (writeErr) return reject(writeErr);
          resolve();
        });
      });
    });
  }
}
