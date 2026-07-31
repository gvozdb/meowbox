const PEM_BLOCK =
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi;
const URI_CREDENTIALS =
  /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+\S+/gi;
const SENSITIVE_ASSIGNMENT =
  /(\b(?:password|passwd|secret|token|credential|authorization|cookie|private[_-]?key|ssh[_-]?key|env(?:[_-]?vars)?|connection[_-]?string|mysql_pwd|pgpassword|restic_password|aws_secret_access_key)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi;
const PASSWORD_ARGUMENT =
  /(\s(?:--password(?:=|\s+)|-p))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const URL_SECRET_PARAMETER =
  /([?&](?:password|secret|token|key|credential)=)[^&#\s]+/gi;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function redactSensitiveText(
  value: string,
  maxLength = 2000,
): string {
  return value
    .replace(ANSI_ESCAPE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(PEM_BLOCK, '[REDACTED:PEM]')
    .replace(URI_CREDENTIALS, '$1[REDACTED]@')
    .replace(AUTHORIZATION_VALUE, '$1 [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
    .replace(PASSWORD_ARGUMENT, '$1[REDACTED]')
    .replace(URL_SECRET_PARAMETER, '$1[REDACTED]')
    .slice(0, Math.max(1, maxLength));
}

export function safeErrorMessage(
  error: unknown,
  fallback = 'Operation failed',
  maxLength = 2000,
): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : fallback;
  return redactSensitiveText(raw.trim() || fallback, maxLength);
}
