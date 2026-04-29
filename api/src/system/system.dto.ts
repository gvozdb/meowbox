import {
  IsArray,
  IsString,
  ArrayMaxSize,
  ArrayMinSize,
  MaxLength,
  Matches,
} from 'class-validator';

/**
 * apt-package имена: [a-z0-9][a-z0-9+.-]*. Запрет пробелов/кавычек/шеллметов
 * layered-defense — CommandExecutor всё равно бросает argv, но зачем лишний
 * риск, если DTO может заткнуть проблему первым.
 */
const APT_PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/i;

export class InstallUpdatesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  @Matches(APT_PACKAGE, { each: true, message: 'Invalid package name' })
  packages!: string[];
}
