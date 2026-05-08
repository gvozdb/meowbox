import {
  IsBoolean,
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
import { VpnProtocol, VPN_USER_NAME_REGEX, IPV4_CIDR_REGEX } from '@meowbox/shared';

const VPN_PROTOCOLS = [VpnProtocol.VLESS_REALITY, VpnProtocol.AMNEZIA_WG];

export class CreateServiceDto {
  @IsIn(VPN_PROTOCOLS)
  protocol!: VpnProtocol;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;

  // VLESS+Reality only
  @IsOptional()
  @IsString()
  @MaxLength(253)
  sniMask?: string;

  // AmneziaWG only
  @IsOptional()
  @IsString()
  @Matches(IPV4_CIDR_REGEX, {
    message: 'network должен быть IPv4 CIDR (например 10.13.13.0/24)',
  })
  network?: string;

  @IsOptional()
  @IsString({ each: true })
  dns?: string[];

  @IsOptional()
  @IsInt()
  @Min(576)
  @Max(9000)
  mtu?: number;
}

export class ValidateSniDto {
  @IsString()
  @MaxLength(253)
  sniMask!: string;
}

export class RotateSniDto {
  @IsString()
  @MaxLength(253)
  newSni!: string;
}

export class CreateUserDto {
  @IsString()
  @Matches(VPN_USER_NAME_REGEX, {
    message: 'name 1..32 символа [a-zA-Z0-9_-. ]',
  })
  name!: string;

  /** Список serviceId, в которых сразу создаём creds. Можно пустой массив — потом добавлять. */
  @IsOptional()
  @IsString({ each: true })
  serviceIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notes?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Matches(VPN_USER_NAME_REGEX)
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notes?: string;
}

export class AddUserToServiceDto {
  @IsString()
  @MinLength(1)
  serviceId!: string;
}
