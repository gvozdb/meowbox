import { IsString, IsNotEmpty, MaxLength, Matches, IsBoolean } from 'class-validator';

const PHP_VERSION = /^\d\.\d$/; // "8.2", "7.4"
const EXT_NAME = /^[a-z0-9_-]+$/i;
const INI_MAX = 1_000_000; // 1 МБ — php.ini никогда не бывает больше

export class InstallPhpVersionDto {
  @IsString()
  @Matches(PHP_VERSION, { message: 'Version must look like "8.2"' })
  version!: string;
}

export class WriteIniDto {
  @IsString()
  @MaxLength(INI_MAX)
  @Matches(/^[^\x00]*$/s, { message: 'INI contains null byte' })
  content!: string;
}

export class ExtensionNameDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(EXT_NAME, { message: 'Extension name format invalid' })
  name!: string;
}

export class ToggleExtensionDto extends ExtensionNameDto {
  @IsBoolean()
  enable!: boolean;
}
