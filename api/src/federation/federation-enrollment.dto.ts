import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class EstablishFederationTrustDto {
  @IsUUID('all')
  issuerInstallationId!: string;

  @IsString()
  @Matches(/^ed25519-[A-Za-z0-9_-]{22}$/)
  keyId!: string;

  @IsString()
  @MaxLength(256)
  @Matches(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  publicKeySpki!: string;

  @IsIn(['ADMIN', 'MANAGER'])
  maxRole!: 'ADMIN' | 'MANAGER';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/, { each: true })
  permissions!: string[];

  @IsInt()
  @Min(1)
  @Max(1)
  principalVersion!: number;

  @IsString()
  @MaxLength(128)
  @Matches(/^SHA256:[A-Za-z0-9+/]{43}=?$/)
  sshFingerprint!: string;
}
