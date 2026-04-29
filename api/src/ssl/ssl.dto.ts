import { IsString, IsNotEmpty, IsOptional, MaxLength, Matches } from 'class-validator';

// PEM-сертификат крайне редко длиннее 32 КБ (chain < 64 КБ). Ограничиваем.
const PEM_MAX = 64 * 1024;
const PEM_BEGIN_CERT = /-----BEGIN CERTIFICATE-----/;
const PEM_BEGIN_KEY = /-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

export class InstallCustomCertDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PEM_MAX)
  @Matches(PEM_BEGIN_CERT, {
    message: 'certPem must contain "BEGIN CERTIFICATE" header',
  })
  certPem!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PEM_MAX)
  @Matches(PEM_BEGIN_KEY, {
    message: 'keyPem must be a PEM private key',
  })
  keyPem!: string;

  @IsOptional()
  @IsString()
  @MaxLength(PEM_MAX)
  @Matches(PEM_BEGIN_CERT, {
    message: 'chainPem must contain "BEGIN CERTIFICATE" header',
  })
  chainPem?: string;
}
