import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { FEDERATED_VPN_MAX_SOURCES } from './federated-vpn.constants';

export class CreateFederatedVpnSubscriptionDto {
  @IsUUID('all')
  vpnUserId!: string;
}

export class AddFederatedVpnSubscriptionSourceDto {
  @IsString()
  @MaxLength(64)
  @Matches(/^(?:main|[A-Za-z0-9._:-]{1,64})$/)
  serverId!: string;

  @IsUUID('all')
  vpnUserId!: string;
}

export class ReorderFederatedVpnSubscriptionSourcesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(FEDERATED_VPN_MAX_SOURCES)
  @IsUUID('all', { each: true })
  sourceIds!: string[];
}
