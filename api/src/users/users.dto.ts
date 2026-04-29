import {
  IsString,
  IsEmail,
  IsNotEmpty,
  MinLength,
  MaxLength,
  IsEnum,
  IsOptional,
  Matches,
} from 'class-validator';

enum UserRole {
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
}

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_.-]+$/, {
    message: 'Username can only contain letters, numbers, underscores, dots, and hyphens',
  })
  username!: string;

  @IsEmail()
  @MaxLength(256)
  email!: string;

  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(256)
  password!: string;

  @IsEnum(UserRole)
  role!: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_.-]+$/, {
    message: 'Username can only contain letters, numbers, underscores, dots, and hyphens',
  })
  username?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(256)
  email?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: string;

  @IsOptional()
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(256)
  password?: string;

  // Подтверждение текущим паролем — обязательно для любого изменения.
  @IsString()
  @IsNotEmpty({ message: 'currentPassword is required' })
  currentPassword!: string;
}
