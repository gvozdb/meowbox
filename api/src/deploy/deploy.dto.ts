import { IsString, IsNotEmpty, IsOptional, MaxLength, Matches } from 'class-validator';

export class TriggerDeployDto {
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9_./-]+$/, {
    message: 'Invalid branch name',
  })
  branch?: string;
}

export class WebhookPayloadDto {
  @IsString()
  @IsNotEmpty()
  ref!: string;

  @IsOptional()
  repository?: {
    full_name?: string;
    clone_url?: string;
    ssh_url?: string;
  };

  @IsOptional()
  head_commit?: {
    id?: string;
    message?: string;
  };
}
