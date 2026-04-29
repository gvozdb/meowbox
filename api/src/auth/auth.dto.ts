import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MinLength,
  MaxLength,
  Matches,
  IsEmail,
  ValidateIf,
} from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_.-]+$/, {
    message: 'Username contains invalid characters',
  })
  username!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

/**
 * Отключение TOTP требует TWO-factor подтверждения:
 *   - текущий пароль (знание — защита от XSS/украденного access-token)
 *   - текущий TOTP-код (обладание — защита от leak пароля)
 *
 * Без пароля украденный JWT позволял бы атакующему выключить 2FA и зайти
 * свободно. Симметрично enableTotp в логике — но там TOTP-код уже подтверждает
 * обладание секретом, так что пароль не нужен (нет что «отменять»).
 */
export class DisableTotpDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  @Matches(/^\d{6}$/, { message: 'TOTP code must be 6 digits' })
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  currentPassword!: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsEmail({}, { message: 'Email format is invalid' })
  @MaxLength(256)
  email?: string;

  // Новый пароль. 12+ символов (см. setup-flow — там тоже 12), чтобы
  // политика была единой.
  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password?: string;

  // Текущий пароль обязателен, если меняется email/password. Без этого
  // украденный access-token позволял захватить аккаунт (достаточно PUT
  // /auth/me с новым паролем/почтой без какой-либо ре-аутентификации).
  @ValidateIf((o: UpdateProfileDto) => !!o.password || !!o.email)
  @IsString()
  @IsNotEmpty({ message: 'Current password is required to change email or password' })
  @MaxLength(256)
  currentPassword?: string;
}
