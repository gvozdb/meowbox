/**
 * Shared MinIO runtime layout.
 *
 * The server is intentionally bound to loopback. Site applications use the
 * S3-compatible API locally; publishing an object-storage endpoint is an
 * explicit infrastructure decision, not an accidental public listener.
 */
export const MINIO_SERVICE_KEY = 'minio';
export const MINIO_SERVICE_USER = 'meowbox-minio';
export const MINIO_SYSTEMD_UNIT = 'meowbox-minio.service';
export const MINIO_SYSTEMD_UNIT_PATH = `/etc/systemd/system/${MINIO_SYSTEMD_UNIT}`;

export const MINIO_RUNTIME_DIR = '/usr/local/lib/meowbox/minio';
export const MINIO_SERVER_BINARY = `${MINIO_RUNTIME_DIR}/minio`;
export const MINIO_CLIENT_BINARY = `${MINIO_RUNTIME_DIR}/mc`;
export const MINIO_DATA_DIR = '/var/lib/meowbox-minio/data';
export const MINIO_HOME_DIR = '/var/lib/meowbox-minio';
export const MINIO_CONFIG_DIR = '/etc/meowbox/minio';
export const MINIO_ROOT_CREDENTIALS_PATH = `${MINIO_CONFIG_DIR}/root.env`;

export const MINIO_API_HOST = '127.0.0.1';
export const MINIO_API_PORT = 9000;
export const MINIO_API_ENDPOINT = `http://${MINIO_API_HOST}:${MINIO_API_PORT}`;
export const MINIO_CONSOLE_HOST = '127.0.0.1';
export const MINIO_CONSOLE_PORT = 9001;
export const MINIO_DEFAULT_REGION = 'us-east-1';

/** Canonical managed unit, shared by the agent and the system migration. */
export function minioSystemdUnitContent(): string {
  return `[Unit]
Description=MinIO object storage (Meowbox)
Documentation=https://min.io/docs/
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${MINIO_SERVICE_USER}
Group=${MINIO_SERVICE_USER}
WorkingDirectory=${MINIO_HOME_DIR}
Environment=HOME=${MINIO_HOME_DIR}
EnvironmentFile=${MINIO_ROOT_CREDENTIALS_PATH}
ExecStart=${MINIO_SERVER_BINARY} server --address ${MINIO_API_HOST}:${MINIO_API_PORT} --console-address ${MINIO_CONSOLE_HOST}:${MINIO_CONSOLE_PORT} ${MINIO_DATA_DIR}
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
UMask=0077
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${MINIO_HOME_DIR}
NoNewPrivileges=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
`;
}
