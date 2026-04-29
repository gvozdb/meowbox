import {
  IsString,
  IsEmail,
  IsNotEmpty,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';

export class SetupDto {
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
}
