import {
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { FederatedWebhookProvider } from '@meowbox/shared';
import {
  DOMAIN_MAX_LENGTH,
  DOMAIN_MESSAGE,
  DOMAIN_REGEX,
} from '../common/validators/site-names';

export class CreateWebhookRouteDto {
  @IsUUID()
  siteId!: string;

  @IsUUID()
  domainId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(DOMAIN_MAX_LENGTH)
  @Matches(DOMAIN_REGEX, { message: DOMAIN_MESSAGE })
  domain!: string;

  @IsIn(['GITHUB', 'GITEA'])
  provider!: FederatedWebhookProvider;

  @IsString()
  @MinLength(16)
  @MaxLength(512)
  @Matches(/^[^\x00\r\n]+$/)
  secret!: string;
}
