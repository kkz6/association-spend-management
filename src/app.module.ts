import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramModule } from './telegram/telegram.module';
import { GoogleSheetsModule } from './google-sheets/google-sheets.module';
import { EnvironmentVariables } from './config/env.validation';
import configuration from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: (config) => {
        const validatedConfig = new EnvironmentVariables();
        Object.assign(validatedConfig, config);
        return validatedConfig;
      },
    }),
    TelegramModule,
    GoogleSheetsModule,
  ],
})
export class AppModule {}
