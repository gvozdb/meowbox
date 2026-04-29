import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  MaxLength,
  Matches,
} from 'class-validator';

enum DatabaseType {
  MARIADB = 'MARIADB',
  MYSQL = 'MYSQL',
  POSTGRESQL = 'POSTGRESQL',
}

export class CreateDatabaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Database name can only contain letters, numbers, and underscores',
  })
  name!: string;

  @IsEnum(DatabaseType)
  type!: string;

  @IsOptional()
  @IsString()
  siteId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Username can only contain letters, numbers, and underscores',
  })
  dbUser?: string;
}

export class UpdateDatabaseDto {
  @IsOptional()
  @IsString()
  siteId?: string;
}
