import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';
import { GoogleSheetsModule } from '../google-sheets/google-sheets.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule, GoogleSheetsModule],
  providers: [TelegramService],
  controllers: [TelegramController],
  exports: [TelegramService],
})
export class TelegramModule {} 