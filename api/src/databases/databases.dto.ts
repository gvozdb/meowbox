import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  MaxLength,
  Matches,
  IsIn,
  IsInt,
  IsUUID,
  Max,
  Min,
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
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Username can only contain letters, numbers, and underscores',
  })
  dbUser?: string;

  @IsOptional()
  @IsIn(['APP_PRIMARY', 'AUXILIARY'])
  purpose?: 'APP_PRIMARY' | 'AUXILIARY';
}

export class UpdateDatabaseDto {
  @IsOptional()
  @IsIn(['APP_PRIMARY', 'AUXILIARY'])
  purpose?: 'APP_PRIMARY' | 'AUXILIARY';
}

export class CreateDatabaseImportSessionDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,180}$/)
  filename!: string;

  @IsInt()
  @Min(1)
  @Max(50 * 1024 ** 3)
  contentLength!: number;
}

export class StartDatabaseImportDto {
  @IsUUID()
  uploadSessionId!: string;
}
