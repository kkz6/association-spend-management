import { IsString, IsNotEmpty, IsNumber, IsOptional, Matches, IsIn, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';

export class EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+:[A-Za-z0-9_-]{35}$/, {
    message: 'TELEGRAM_BOT_TOKEN must be a valid Telegram bot token',
  })
  TELEGRAM_BOT_TOKEN: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, {
    message: 'GOOGLE_CLIENT_EMAIL must be a valid email address',
  })
  GOOGLE_CLIENT_EMAIL: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^-----BEGIN PRIVATE KEY-----\n[\s\S]*\n-----END PRIVATE KEY-----\n$/, {
    message: 'GOOGLE_PRIVATE_KEY must be a valid private key in PEM format',
  })
  GOOGLE_PRIVATE_KEY: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_-]{44}$/, {
    message: 'SPREADSHEET_ID must be a valid Google Spreadsheet ID',
  })
  SPREADSHEET_ID: string;

  @IsString()
  @IsOptional()
  @Matches(/^[a-zA-Z0-9_-]{33}$/, {
    message: 'GOOGLE_DRIVE_FOLDER_ID must be a valid Google Drive folder ID',
  })
  GOOGLE_DRIVE_FOLDER_ID?: string;

  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(65535)
  @Transform(({ value }) => parseInt(value, 10))
  PORT?: number = 3000;

  @IsString()
  @IsOptional()
  @IsIn(['development', 'production', 'test'])
  NODE_ENV?: string = 'development';
} 