import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Matches } from 'class-validator';

/**
 * DTO для обновления настроек доступа к панели (домен, redirect, deny-ip).
 * Эндпоинт ПЕРЕРИСОВЫВАЕТ nginx-конфиг и делает reload — поэтому валидация
 * жёсткая, мусорные значения не должны доехать до файловой системы.
 */
export class UpdatePanelAccessDto {
  /**
   * DNS-имя панели. null или пустая строка → отвязка домена.
   * Жёсткая регулярка: только буквы/цифры/точки/дефис, до 253 символов,
   * без .. (защита от traversal — на всякий случай: попадает в server_name).
   */
  @IsOptional()
  @IsString()
  @Matches(/^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/, {
    message: 'domain должен быть валидным DNS-именем (например panel.example.com)',
  })
  domain?: string | null;

  /** 301 редирект http://… → https://… (имеет смысл только если есть cert). */
  @IsOptional()
  @IsBoolean()
  httpsRedirect?: boolean;

  /**
   * Запретить доступ через IP:PORT. Требует валидный cert + привязанный domain;
   * без них контроллер вернёт BadRequest.
   */
  @IsOptional()
  @IsBoolean()
  denyIpAccess?: boolean;
}

export class IssueLeDto {
  /** Email регистрации в LE (обязателен — без него LE будет ругаться). */
  @IsEmail({}, { message: 'email обязателен и должен быть валидным' })
  email!: string;
}

export class GenerateSelfSignedDto {
  /**
   * Опциональный домен в SAN. Если не задан — берётся текущий domain из настроек
   * или IP сервера (агент сам определит).
   */
  @IsOptional()
  @IsString()
  cn?: string;
}

export class SetDomainDto {
  /**
   * DNS-имя или null для отвязки. Валидация — та же, что в UpdatePanelAccessDto.
   * Принимаем null/пустую строку для удобства фронта.
   */
  @IsOptional()
  @IsString()
  domain?: string | null;
}

/** Допустимые значения certMode для type guards. */
export const CERT_MODES = ['NONE', 'SELFSIGNED', 'LE'] as const;
export type CertMode = (typeof CERT_MODES)[number];

export function isCertMode(v: unknown): v is CertMode {
  return typeof v === 'string' && (CERT_MODES as readonly string[]).includes(v);
}

/** Хелпер — игнорировать unused (валидаторы). */
void IsIn;
