import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateFederationEnrollmentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[\p{L}\p{N} _.-]+$/u)
  displayName!: string;

  @IsString()
  @MaxLength(253)
  @Matches(/^[A-Za-z0-9.:-]+$/)
  sshHost!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  sshPort?: number;

  @IsString()
  @Matches(/^SHA256:[A-Za-z0-9+/]{43}$/)
  sshFingerprint!: string;

  @IsString()
  @MaxLength(512)
  @Matches(/^https:\/\/[\x21-\x7e]+$/)
  apiOrigin!: string;

  @IsString()
  @MaxLength(512)
  @Matches(/^https:\/\/[\x21-\x7e]+$/)
  wsOrigin!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  wsPath?: string;

  @IsString()
  @MaxLength(512)
  @Matches(/^https:\/\/[\x21-\x7e]+$/)
  browserPublicOrigin!: string;

  @IsString()
  @MaxLength(512)
  @Matches(/^https:\/\/[\x21-\x7e]+$/)
  directTransferOrigin!: string;

  @IsString()
  @Matches(/^sha256\/[A-Za-z0-9+/]{43}=$/)
  spkiSha256!: string;

  @IsOptional()
  @IsIn(['ADMIN', 'MANAGER'])
  maxRole?: 'ADMIN' | 'MANAGER';
}

export class ResumeFederationEnrollmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  sshPassword!: string;
}
