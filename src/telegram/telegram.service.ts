import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as TelegramBot from 'node-telegram-bot-api';
import { GoogleSheetsService } from '../google-sheets/google-sheets.service';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createWorker, Worker, createScheduler } from 'tesseract.js';
import * as Sentry from '@sentry/node';

interface ExtractedInfo {
  amount?: number;
  category?: string;
  description?: string;
  date?: string;
  type?: 'expense' | 'income';
  confidence: number;
}

interface FlatInfo {
  flatNumber: string;
  floorNumber: string;
  ownerName: string;
  tenantName?: string;
  maintenanceAmount: number;
  phoneNumber: string;
  email?: string;
  isOccupied: boolean;
  lastUpdated: string;
}

type UserStateType = 'expense' | 'income' | 'flat_info' | 'collection_info';

interface UserState {
  type: UserStateType;
  extractedInfo?: ExtractedInfo | FlatInfo;
  pendingQuestions?: string[];
  receiptUrl?: string;
  userName?: string;
  collectionType?: CollectionSheet;
}

interface CollectionSheet {
  type: 'maintenance' | 'water' | 'other';
  month: string;
  year: number;
  description?: string;
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private bot: TelegramBot;
  private readonly allowedUsers: Set<number> = new Set();
  private scheduler: ReturnType<typeof createScheduler>;
  private userStates: Map<number, UserState> = new Map();
  private genAI: GoogleGenerativeAI;

  constructor(
    private configService: ConfigService,
    private googleSheetsService: GoogleSheetsService,
    private googleDriveService: GoogleDriveService,
  ) {
    this.scheduler = createScheduler();
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not defined');
    }
    this.genAI = new GoogleGenerativeAI(apiKey);

    // Initialize allowed users from environment variable
    const allowedUserIds = this.configService.get<string>('ALLOWED_TELEGRAM_USER_IDS');
    if (allowedUserIds) {
      allowedUserIds.split(',').forEach(id => {
        const userId = parseInt(id.trim());
        if (!isNaN(userId)) {
          this.allowedUsers.add(userId);
        }
      });
    }
  }

  private async logAccessAttempt(user: TelegramBot.User, isAuthorized: boolean) {
    // Only log unauthorized access attempts
    if (!isAuthorized) {
      const timestamp = new Date().toISOString();
      const userInfo = {
        id: user.id,
        username: user.username || 'No username',
        firstName: user.first_name,
        lastName: user.last_name || 'No last name',
        timestamp
      };

      // Log to console
      console.log('Unauthorized Bot Access Attempt:', userInfo);
    }
  }

  private isUserAuthorized(userId: number): boolean {
    return this.allowedUsers.has(userId);
  }

  private async handleUnauthorizedUser(chatId: number, user: TelegramBot.User) {
    await this.logAccessAttempt(user, false);
    await this.bot.sendMessage(
      chatId,
      '⛔ You are not authorized to use this bot. Please contact the administrator for access.'
    );
  }

  async onModuleInit() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not defined');
    }
    this.bot = new TelegramBot(token, { polling: true });
    
    // Set up the menu button
    await this.bot.setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'expense', description: 'Add an expense' },
      { command: 'income', description: 'Add an income' },
      { command: 'report', description: 'View monthly report' },
      { command: 'flats', description: 'Manage flats' },
      { command: 'maintenance', description: 'Collect maintenance' },
      { command: 'collection', description: 'Create collection' }
    ]);

    this.setupBotHandlers();
  }

  private async extractInfoFromText(text: string): Promise<ExtractedInfo> {
    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    
    const prompt = `Extract financial information from the following text. Return a JSON object with these fields:
    - amount: number (the monetary value)
    - category: string (e.g., Maintenance, Utilities, Dues)
    - description: string (what the expense/income is for)
    - date: string (in YYYY-MM-DD format, if found)
    - type: 'expense' or 'income'
    - confidence: number (0-1, how confident you are in the extraction)

    Text: ${text}

    Return ONLY the JSON object, no other text or formatting. If any field is unclear, set it to null. Only include fields you're confident about.`;

    try {
      const result = await Promise.race([
        model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            topK: 1,
            topP: 1,
            maxOutputTokens: 2048,
          },
        }),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Request timed out')), 30000)
        )
      ]);
      
      const response = await result.response;
      const text = response.text().trim();
      const cleanText = text.replace(/```json\n?|\n?```/g, '');
      const extractedInfo = JSON.parse(cleanText) as ExtractedInfo;
      
      return extractedInfo;
    } catch (error) {
      Sentry.captureException(error, {
        extra: {
          text,
          prompt,
        },
      });
      throw new Error('Failed to extract information from the text. Please try entering the details manually.');
    }
  }

  private async askFollowUpQuestions(chatId: number, extractedInfo: ExtractedInfo) {
    const questions: string[] = [];
    const userState = this.userStates.get(chatId);
    if (!userState) {
      Sentry.captureMessage('No user state found for follow-up questions', {
        extra: { chatId, extractedInfo },
      });
      return;
    }

    if (!extractedInfo.amount) {
      questions.push('What is the amount?');
    }
    if (!extractedInfo.category) {
      questions.push('What is the category? (e.g., Maintenance, Utilities, Dues)');
    }
    if (!extractedInfo.description) {
      questions.push('What is this expense/income for?');
    }
    if (!extractedInfo.date) {
      questions.push('What is the date? (YYYY-MM-DD)');
    }

    if (questions.length > 0) {
      this.userStates.set(chatId, {
        type: userState.type,
        extractedInfo,
        pendingQuestions: questions,
        receiptUrl: userState.receiptUrl,
        userName: userState.userName,
      });
      await this.bot.sendMessage(chatId, questions[0]);
    } else {
      await this.confirmAndSaveEntry(chatId, extractedInfo);
    }
  }

  private isExtractedInfo(info: ExtractedInfo | FlatInfo | undefined): info is ExtractedInfo {
    return info !== undefined && 'confidence' in info;
  }

  private isFlatInfo(info: ExtractedInfo | FlatInfo | undefined): info is FlatInfo {
    return info !== undefined && 'flatNumber' in info;
  }

  private getEntryType(type: UserStateType): 'expense' | 'income' {
    if (type === 'flat_info' || type === 'collection_info') {
      return 'expense';
    }
    return type;
  }

  private async handleFlatInfoInput(chatId: number, userState: UserState, text: string) {
    if (!userState.pendingQuestions || userState.pendingQuestions.length === 0) {
      return;
    }

    const currentQuestion = userState.pendingQuestions[0];
    const answer = text.trim();
    const remainingQuestions = userState.pendingQuestions.slice(1);

    // Initialize flatInfo first
    let flatInfo: Partial<FlatInfo>;
    if (this.isFlatInfo(userState.extractedInfo)) {
      flatInfo = { ...userState.extractedInfo };
    } else {
      flatInfo = {};
    }

    // Handle skip command
    if (answer.toLowerCase() === 'skip') {
      // For required fields, don't allow skipping
      if (currentQuestion.includes('flat number') || 
          currentQuestion.includes('floor number') || 
          currentQuestion.includes('owner name') || 
          currentQuestion.includes('maintenance amount') || 
          currentQuestion.includes('phone number') || 
          currentQuestion.includes('occupied')) {
        await this.bot.sendMessage(chatId, '❌ This field is required. Please provide a value.');
        return;
      }

      // For optional fields, proceed to next question
      if (remainingQuestions.length > 0) {
        await this.bot.sendMessage(chatId, remainingQuestions[0]);
        
        // Update state with remaining questions
        const newState: UserState = {
          type: 'flat_info',
          extractedInfo: flatInfo as FlatInfo,
          pendingQuestions: remainingQuestions,
          userName: userState.userName
        };
        
        this.userStates.set(chatId, newState);
      } else {
        try {
          // Ensure all required fields are present
          if (!flatInfo.flatNumber || !flatInfo.floorNumber || !flatInfo.ownerName || 
              !flatInfo.maintenanceAmount || !flatInfo.phoneNumber) {
            throw new Error('Missing required flat information');
          }

          const completeFlatInfo: FlatInfo = {
            flatNumber: flatInfo.flatNumber,
            floorNumber: flatInfo.floorNumber,
            ownerName: this.capitalizeName(flatInfo.ownerName),
            maintenanceAmount: flatInfo.maintenanceAmount,
            phoneNumber: flatInfo.phoneNumber,
            isOccupied: flatInfo.isOccupied || false,
            lastUpdated: new Date().toISOString(),
            tenantName: flatInfo.tenantName ? this.capitalizeName(flatInfo.tenantName) : undefined,
            email: flatInfo.email
          };

          await this.googleSheetsService.updateFlatInfo(completeFlatInfo);
          await this.bot.sendMessage(chatId, '✅ Flat information saved successfully!');
          this.userStates.delete(chatId);
        } catch (error) {
          console.error('Error saving flat info:', error);
          await this.bot.sendMessage(chatId, '❌ Error saving flat information. Please try again.');
        }
      }
      return;
    }

    // Handle regular input
    if (currentQuestion.includes('flat number')) {
      flatInfo.flatNumber = answer;
    } else if (currentQuestion.includes('floor number')) {
      flatInfo.floorNumber = answer;
    } else if (currentQuestion.includes('owner name')) {
      flatInfo.ownerName = this.capitalizeName(answer);
    } else if (currentQuestion.includes('maintenance amount')) {
      flatInfo.maintenanceAmount = parseFloat(answer);
    } else if (currentQuestion.includes('phone number')) {
      flatInfo.phoneNumber = answer;
    } else if (currentQuestion.includes('occupied')) {
      flatInfo.isOccupied = answer.toLowerCase() === 'yes';
    } else if (currentQuestion.includes('tenant name')) {
      flatInfo.tenantName = this.capitalizeName(answer);
    } else if (currentQuestion.includes('email')) {
      flatInfo.email = answer;
    }

    if (remainingQuestions.length > 0) {
      await this.bot.sendMessage(chatId, remainingQuestions[0]);
      
      // Update state with remaining questions
      const newState: UserState = {
        type: 'flat_info',
        extractedInfo: flatInfo as FlatInfo,
        pendingQuestions: remainingQuestions,
        userName: userState.userName
      };
      
      this.userStates.set(chatId, newState);
    } else {
      try {
        // Ensure all required fields are present
        if (!flatInfo.flatNumber || !flatInfo.floorNumber || !flatInfo.ownerName || 
            !flatInfo.maintenanceAmount || !flatInfo.phoneNumber) {
          throw new Error('Missing required flat information');
        }

        const completeFlatInfo: FlatInfo = {
          flatNumber: flatInfo.flatNumber,
          floorNumber: flatInfo.floorNumber,
          ownerName: this.capitalizeName(flatInfo.ownerName),
          maintenanceAmount: flatInfo.maintenanceAmount,
          phoneNumber: flatInfo.phoneNumber,
          isOccupied: flatInfo.isOccupied || false,
          lastUpdated: new Date().toISOString(),
          tenantName: flatInfo.tenantName ? this.capitalizeName(flatInfo.tenantName) : undefined,
          email: flatInfo.email
        };

        await this.googleSheetsService.updateFlatInfo(completeFlatInfo);
        await this.bot.sendMessage(chatId, '✅ Flat information saved successfully!');
        this.userStates.delete(chatId);
      } catch (error) {
        console.error('Error saving flat info:', error);
        await this.bot.sendMessage(chatId, '❌ Error saving flat information. Please try again.');
      }
    }
  }

  private capitalizeName(name: string): string {
    return name
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  private async confirmAndSaveEntry(chatId: number, info: ExtractedInfo) {
    const userState = this.userStates.get(chatId);
    if (!userState) {
      Sentry.captureMessage('No user state found for confirmation', {
        extra: { chatId, info },
      });
      return;
    }

    const entry = {
      amount: info.amount || 0,
      category: info.category || '',
      description: info.description || '',
      date: info.date || new Date().toISOString().split('T')[0],
      type: this.getEntryType(userState.type),
      receiptUrl: userState.receiptUrl || '',
      addedBy: userState.userName || 'Unknown',
    };

    const confirmationMessage = `Please confirm the following details:\n\n` +
      `Amount: ${entry.amount}\n` +
      `Category: ${entry.category}\n` +
      `Description: ${entry.description}\n` +
      `Date: ${entry.date}\n` +
      `Type: ${entry.type}\n` +
      (entry.receiptUrl ? `Receipt: ${entry.receiptUrl}\n` : '') +
      `Added By: ${entry.addedBy}\n` +
      `\nIs this correct? (yes/no)`;

    await this.bot.sendMessage(chatId, confirmationMessage);
    this.userStates.set(chatId, { 
      type: userState.type,
      extractedInfo: { ...info, confidence: info.confidence },
      receiptUrl: userState.receiptUrl,
      userName: userState.userName,
    });
  }

  private setupBotHandlers() {
    // Start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      if (!msg.from) {
        await this.bot.sendMessage(chatId, 'Error: Could not identify user. Please try again.');
        return;
      }

      // Check if user is authorized
      if (!this.isUserAuthorized(msg.from.id)) {
        await this.handleUnauthorizedUser(chatId, msg.from);
        return;
      }

      // Log authorized access
      await this.logAccessAttempt(msg.from, true);

      // Store user's name when they start using the bot
      this.userStates.set(chatId, { 
        type: 'expense',
        userName: `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`
      });

      const keyboard = {
        inline_keyboard: [
          [
            { text: '➕ Add Expense', callback_data: 'add_expense' },
            { text: '➕ Add Income', callback_data: 'add_income' }
          ],
          [
            { text: '📊 Monthly Report', callback_data: 'monthly_report' },
            { text: '📈 Quarterly Report', callback_data: 'quarterly_report' }
          ],
          [
            { text: '🏢 Manage Flats', callback_data: 'manage_flats' },
            { text: '💰 Collect Maintenance', callback_data: 'collect_maintenance' }
          ],
          [
            { text: '📋 Create Collection', callback_data: 'create_collection' }
          ]
        ]
      };

      await this.bot.sendMessage(
        chatId,
        'Welcome to the Flat Association Expense Bot! 🏢\n\n' +
        'Please select an option:',
        { reply_markup: keyboard }
      );
    });

    // Expense command
    this.bot.onText(/\/expense/, async (msg) => {
      const chatId = msg.chat.id;
      if (!msg.from) {
        await this.bot.sendMessage(chatId, 'Error: Could not identify user. Please try again.');
        return;
      }

      if (!this.isUserAuthorized(msg.from.id)) {
        await this.handleUnauthorizedUser(chatId, msg.from);
        return;
      }

      await this.logAccessAttempt(msg.from, true);
      this.userStates.set(chatId, { 
        type: 'expense',
        userName: `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`
      });

      await this.bot.sendMessage(
        chatId,
        'Please enter the expense details in the following format:\n' +
        'Amount, Category, Description\n' +
        'Example: 1000, Maintenance, Monthly cleaning\n\n' +
        'Or upload a receipt image.'
      );
    });

    // Income command
    this.bot.onText(/\/income/, async (msg) => {
      const chatId = msg.chat.id;
      if (!msg.from) {
        await this.bot.sendMessage(chatId, 'Error: Could not identify user. Please try again.');
        return;
      }

      if (!this.isUserAuthorized(msg.from.id)) {
        await this.handleUnauthorizedUser(chatId, msg.from);
        return;
      }

      await this.logAccessAttempt(msg.from, true);
      this.userStates.set(chatId, { 
        type: 'income',
        userName: `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`
      });

      await this.bot.sendMessage(
        chatId,
        'Please enter the income details in the following format:\n' +
        'Amount, Category, Description\n' +
        'Example: 5000, Dues, Monthly maintenance\n\n' +
        'Or upload a receipt image.'
      );
    });

    // Report command
    this.bot.onText(/\/report/, async (msg) => {
      const chatId = msg.chat.id;
      if (!msg.from) {
        await this.bot.sendMessage(chatId, 'Error: Could not identify user. Please try again.');
        return;
      }

      if (!this.isUserAuthorized(msg.from.id)) {
        await this.handleUnauthorizedUser(chatId, msg.from);
        return;
      }

      await this.logAccessAttempt(msg.from, true);
      await this.bot.sendMessage(chatId, '📊 Generating monthly report...');
      
      try {
        const date = new Date();
        const month = date.toLocaleString('default', { month: 'long' });
        const year = date.getFullYear();
        const sheetName = `${month} ${year}`;

        const response = await this.googleSheetsService.getSheetData(sheetName);
        if (!response || response.length <= 2) {
          await this.bot.sendMessage(chatId, 'No entries found for this month.');
          return;
        }

        let totalExpenses = 0;
        let totalIncome = 0;
        const entries: string[] = [];

        for (let i = 2; i < response.length; i++) {
          const row = response[i];
          const amountStr = row[4]?.replace(/[₹,]/g, '') || '0';
          const amount = parseFloat(amountStr);
          
          if (row[1]?.toLowerCase() === 'expense') {
            totalExpenses += amount;
          } else if (row[1]?.toLowerCase() === 'income') {
            totalIncome += amount;
          }

          entries.push(
            `${row[0]} - ${row[1].toUpperCase()} - ${row[2]}\n` +
            `${row[3]} - ${row[4]}`
          );
        }

        const netBalance = totalIncome - totalExpenses;
        const balanceEmoji = netBalance >= 0 ? '🟢' : '🔴';

        let message = `📊 Monthly Report - ${month} ${year}\n\n`;
        message += `Total Income: ₹${totalIncome.toLocaleString('en-IN')}\n`;
        message += `Total Expenses: ₹${totalExpenses.toLocaleString('en-IN')}\n`;
        message += `Net Balance: ${balanceEmoji} ₹${netBalance.toLocaleString('en-IN')}\n\n`;
        message += 'Recent Transactions:\n\n';
        message += entries.slice(-5).join('\n\n');

        await this.bot.sendMessage(chatId, message);
      } catch (error) {
        console.error('Error generating report:', error);
        await this.bot.sendMessage(chatId, '❌ Error generating report. Please try again.');
      }
    });

    // Flats command
    this.bot.onText(/\/flats/, async (msg) => {
      const chatId = msg.chat.id;
      if (!msg.from) {
        await this.bot.sendMessage(chatId, 'Error: Could not identify user. Please try again.');
        return;
      }

      if (!this.isUserAuthorized(msg.from.id)) {
        await this.handleUnauthorizedUser(chatId, msg.from);
        return;
      }

      await this.logAccessAttempt(msg.from, true);

      const keyboard = {
        inline_keyboard: [
          [
            { text: '➕ Add Flat', callback_data: 'add_flat' },
            { text: '📝 Update Flat', callback_data: 'update_flat' }
          ],
          [
            { text: '👥 View All Flats', callback_data: 'view_flats' },
            { text: '🔍 Search Flat', callback_data: 'search_flat' }
          ],
          [
            { text: '🔙 Back to Main Menu', callback_data: 'main_menu' }
          ]
        ]
      };

      await this.bot.sendMessage(
        chatId,
        '🏢 Flat Management\n\n' +
        'Please select an option:',
        { reply_markup: keyboard }
      );
    });

    // Maintenance command
    this.bot.onText(/\/maintenance/, async (msg) => {
      const chatId = msg.chat.id;
      if (!msg.from) {
        await this.bot.sendMessage(chatId, 'Error: Could not identify user. Please try again.');
        return;
      }

      if (!this.isUserAuthorized(msg.from.id)) {
        await this.handleUnauthorizedUser(chatId, msg.from);
        return;
      }

      await this.logAccessAttempt(msg.from, true);

      try {
        const currentDate = new Date();
        const collectionType: CollectionSheet = {
          type: 'maintenance',
          month: currentDate.toLocaleString('default', { month: 'long' }),
          year: currentDate.getFullYear()
        };
        
        await this.googleSheetsService.initializeCollection(collectionType, 0);
        
        const flats = await this.googleSheetsService.getAllFlats();
        const currentQuarter = Math.floor(currentDate.getMonth() / 3) + 1;

        let message = `💰 Maintenance Collection - Q${currentQuarter} ${currentDate.getFullYear()}\n\n`;
        let totalExpected = 0;

        for (const flat of flats) {
          totalExpected += flat.maintenanceAmount;
          message += `Flat ${flat.flatNumber}:\n`;
          message += `Owner: ${flat.ownerName}\n`;
          message += `Amount: ₹${flat.maintenanceAmount.toLocaleString('en-IN')}\n`;
          message += `Phone: ${flat.phoneNumber}\n\n`;
        }

        message += `\nTotal Expected: ₹${totalExpected.toLocaleString('en-IN')}`;

        const maintenanceKeyboard = {
          inline_keyboard: [
            [
              { text: '📝 Update Payment Status', callback_data: 'update_payment_status' },
              { text: '📊 Collection Report', callback_data: 'collection_report' }
            ],
            [
              { text: '🔙 Back to Main Menu', callback_data: 'main_menu' }
            ]
          ]
        };

        await this.bot.sendMessage(chatId, message, { reply_markup: maintenanceKeyboard });
      } catch (error) {
        console.error('Error in maintenance command:', error);
        await this.bot.sendMessage(chatId, '❌ Error initializing maintenance collection. Please try again.');
      }
    });

    // Collection command
    this.bot.onText(/\/collection/, async (msg) => {
      const chatId = msg.chat.id;
      if (!msg.from) {
        await this.bot.sendMessage(chatId, 'Error: Could not identify user. Please try again.');
        return;
      }

      if (!this.isUserAuthorized(msg.from.id)) {
        await this.handleUnauthorizedUser(chatId, msg.from);
        return;
      }

      await this.logAccessAttempt(msg.from, true);

      const collectionKeyboard = {
        inline_keyboard: [
          [
            { text: '💧 Water Bill', callback_data: 'create_water_collection' },
            { text: '🔧 Maintenance', callback_data: 'create_maintenance_collection' }
          ],
          [
            { text: '📝 Other Collection', callback_data: 'create_other_collection' }
          ],
          [
            { text: '📊 View Existing Collections', callback_data: 'view_collections' }
          ],
          [
            { text: '🔙 Back to Main Menu', callback_data: 'main_menu' }
          ]
        ]
      };

      await this.bot.sendMessage(
        chatId,
        '📋 Create New Collection\n\n' +
        'Select the type of collection to create:',
        { reply_markup: collectionKeyboard }
      );
    });

    // Handle callback queries (button clicks)
    this.bot.on('callback_query', async (callbackQuery) => {
      if (!callbackQuery.message || !callbackQuery.data || !callbackQuery.from) {
        await this.bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Error: Invalid message or data'
        });
        return;
      }

      const chatId = callbackQuery.message.chat.id;

      // Check if user is authorized
      if (!this.isUserAuthorized(callbackQuery.from.id)) {
        await this.handleUnauthorizedUser(chatId, callbackQuery.from);
        await this.bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Log authorized access
      await this.logAccessAttempt(callbackQuery.from, true);

      const data = callbackQuery.data;

      // Store user's name if not already stored
      const currentState = this.userStates.get(chatId);
      const userState: UserState = {
        type: currentState?.type || 'expense',
        userName: currentState?.userName || `${callbackQuery.from.first_name}${callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : ''}`,
        extractedInfo: currentState?.extractedInfo,
        pendingQuestions: currentState?.pendingQuestions,
        receiptUrl: currentState?.receiptUrl
      };

      if (data.startsWith('view_collection_')) {
        const parts = data.split('_');
        const viewType = parts[2];
        const viewMonth = parts[3];
        const viewYear = parseInt(parts[4]);
        
        const viewCollectionType: CollectionSheet = {
          type: viewType as 'maintenance' | 'water' | 'other',
          month: viewMonth,
          year: viewYear
        };
        
        try {
          const collection = await this.googleSheetsService.getCollection(viewCollectionType);
          if (!collection || collection.length === 0) {
            await this.bot.sendMessage(chatId, 'No data found for this collection.');
            return;
          }

          let message = `📋 ${viewType === 'other' ? collection[0].description : viewType.charAt(0).toUpperCase() + viewType.slice(1)} Collection - ${viewMonth} ${viewYear}\n\n`;
          
          const totalAmount = collection.reduce((sum, item) => sum + item.amount, 0);
          const paidAmount = collection
            .filter(item => item.status === 'Paid')
            .reduce((sum, item) => sum + item.amount, 0);
          
          message += `Total Amount: ₹${totalAmount.toLocaleString('en-IN')}\n`;
          message += `Paid Amount: ₹${paidAmount.toLocaleString('en-IN')}\n`;
          message += `Pending Amount: ₹${(totalAmount - paidAmount).toLocaleString('en-IN')}\n\n`;
          
          message += 'Flat-wise Status:\n\n';
          collection.forEach(item => {
            message += `Flat ${item.flatNumber} (${item.ownerName})\n`;
            message += `Amount: ₹${item.amount.toLocaleString('en-IN')}\n`;
            message += `Status: ${item.status === 'Paid' ? '✅ Paid' : '⏳ Pending'}\n`;
            if (item.status === 'Paid' && item.paymentDate) {
              message += `Payment Date: ${item.paymentDate}\n`;
              message += `Marked by: ${item.markedBy || 'Unknown'}\n`;
            }
            message += '\n';
          });

          const keyboard = {
            inline_keyboard: [
              [{ text: '📝 Update Payment Status', callback_data: `update_collection_${viewType}_${viewMonth}_${viewYear}` }],
              [{ text: '🔙 Back to Collections', callback_data: 'view_collections' }]
            ]
          };

          await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
        } catch (error) {
          console.error('Error viewing collection:', error);
          await this.bot.sendMessage(chatId, '❌ Error retrieving collection data. Please try again.');
        }
      } else if (data.startsWith('update_collection_')) {
        const parts = data.split('_');
        const updateType = parts[2];
        const updateMonth = parts[3];
        const updateYear = parseInt(parts[4]);
        
        const updateCollectionType: CollectionSheet = {
          type: updateType as 'maintenance' | 'water' | 'other',
          month: updateMonth,
          year: updateYear
        };
        
        try {
          const collection = await this.googleSheetsService.getCollection(updateCollectionType);
          if (!collection || collection.length === 0) {
            await this.bot.sendMessage(chatId, 'No data found for this collection.');
            return;
          }

          // Create keyboard with flat options
          const keyboard = {
            inline_keyboard: collection.map(item => [{
              text: `Flat ${item.flatNumber} (${item.status === 'Paid' ? '✅' : '⏳'})`,
              callback_data: `update_flat_${item.flatNumber}_${updateType}_${updateMonth}_${updateYear}`
            }])
          };

          // Add back button
          keyboard.inline_keyboard.push([{ text: '🔙 Back', callback_data: `view_collection_${updateType}_${updateMonth}_${updateYear}` }]);

          await this.bot.sendMessage(
            chatId,
            'Select a flat to update its payment status:',
            { reply_markup: keyboard }
          );
        } catch (error) {
          console.error('Error handling update collection:', error);
          await this.bot.sendMessage(chatId, 'An error occurred while fetching collection data.');
        }
      } else if (data.startsWith('update_flat_')) {
        const parts = data.split('_');
        const flatNumber = parts[2];
        const updateType = parts[3];
        const updateMonth = parts[4];
        const updateYear = parseInt(parts[5]);
        
        const updateCollectionType: CollectionSheet = {
          type: updateType as 'maintenance' | 'water' | 'other',
          month: updateMonth,
          year: updateYear
        };
        
        await this.handleFlatPaymentUpdate(chatId, flatNumber, userState.userName || 'Unknown', updateCollectionType);
      } else {
        // Handle other cases
        switch (data) {
          case 'add_expense':
            userState.type = 'expense';
            this.userStates.set(chatId, userState);
            await this.bot.sendMessage(
              chatId,
              'Please enter the expense details in the following format:\n' +
              'Amount, Category, Description\n' +
              'Example: 1000, Maintenance, Monthly cleaning\n\n' +
              'Or upload a receipt image.'
            );
            break;

          case 'add_income':
            userState.type = 'income';
            this.userStates.set(chatId, userState);
            await this.bot.sendMessage(
              chatId,
              'Please enter the income details in the following format:\n' +
              'Amount, Category, Description\n' +
              'Example: 5000, Dues, Monthly maintenance\n\n' +
              'Or upload a receipt image.'
            );
            break;

          case 'monthly_report':
            try {
              await this.bot.sendMessage(chatId, '📊 Generating monthly report...');
              
              // Get current month's data
              const date = new Date();
              const month = date.toLocaleString('default', { month: 'long' });
              const year = date.getFullYear();
              const sheetName = `${month} ${year}`;

              // Get data from Google Sheets
              const response = await this.googleSheetsService.getSheetData(sheetName);
              if (!response || response.length <= 2) { // Only headers and totals
                await this.bot.sendMessage(chatId, 'No entries found for this month.');
                return;
              }

              // Calculate totals
              let totalExpenses = 0;
              let totalIncome = 0;
              const entries: string[] = [];

              // Start from index 2 to skip headers and totals row
              for (let i = 2; i < response.length; i++) {
                const row = response[i];
                const amountStr = row[4]?.replace(/[₹,]/g, '') || '0';
                const amount = parseFloat(amountStr);
                
                if (row[1]?.toLowerCase() === 'expense') {
                  totalExpenses += amount;
                } else if (row[1]?.toLowerCase() === 'income') {
                  totalIncome += amount;
                }

                // Format entry for report
                entries.push(
                  `${row[0]} - ${row[1].toUpperCase()} - ${row[2]}\n` +
                  `${row[3]} - ${row[4]}`
                );
              }

              const netBalance = totalIncome - totalExpenses;
              const balanceEmoji = netBalance >= 0 ? '🟢' : '🔴';

              // Create report message
              const report = [
                `📊 Monthly Report - ${month} ${year}`,
                '━━━━━━━━━━━━━━━━━━━━',
                '',
                `💰 Total Income: ₹${totalIncome.toLocaleString('en-IN')}`,
                `💸 Total Expenses: ₹${totalExpenses.toLocaleString('en-IN')}`,
                `${balanceEmoji} Net Balance: ${netBalance >= 0 ? '+' : ''}₹${netBalance.toLocaleString('en-IN')}`,
                '',
                '📝 Recent Entries:',
                '━━━━━━━━━━━━━━━━━━━━',
                ...entries.slice(-5), // Show last 5 entries
                '',
                'View full report in Google Sheets'
              ].join('\n');

              await this.bot.sendMessage(chatId, report);
            } catch (error) {
              console.error('Error generating monthly report:', error);
              Sentry.captureException(error);
              await this.bot.sendMessage(chatId, '❌ Error generating monthly report. Please try again later.');
            }
            break;

          case 'quarterly_report':
            await this.bot.sendMessage(chatId, '📈 Generating quarterly report...');
            // TODO: Implement quarterly report
            break;

          case 'manage_flats':
            const keyboard = {
              inline_keyboard: [
                [
                  { text: '➕ Add Flat', callback_data: 'add_flat' },
                  { text: '📝 Update Flat', callback_data: 'update_flat' }
                ],
                [
                  { text: '👥 View All Flats', callback_data: 'view_flats' },
                  { text: '🔍 Search Flat', callback_data: 'search_flat' }
                ],
                [
                  { text: '🔙 Back to Main Menu', callback_data: 'main_menu' }
                ]
              ]
            };

            await this.bot.sendMessage(
              chatId,
              '🏢 Flat Management\n\n' +
              'Please select an option:',
              { reply_markup: keyboard }
            );
            break;

          case 'view_flats':
            try {
              const flats = await this.googleSheetsService.getAllFlats();
              if (!flats || flats.length === 0) {
                await this.bot.sendMessage(chatId, 'No flats found in the database.');
                return;
              }

              let message = '🏢 All Flats Information:\n\n';
              for (const flat of flats) {
                message += `Flat ${flat.flatNumber}:\n`;
                message += `Floor: ${flat.floorNumber}\n`;
                message += `Owner: ${flat.ownerName}\n`;
                if (flat.tenantName) {
                  message += `Tenant: ${flat.tenantName}\n`;
                }
                message += `Maintenance: ₹${flat.maintenanceAmount.toLocaleString('en-IN')}\n`;
                message += `Phone: ${flat.phoneNumber}\n`;
                if (flat.email) {
                  message += `Email: ${flat.email}\n`;
                }
                message += `Status: ${flat.isOccupied ? 'Occupied' : 'Vacant'}\n`;
                message += `Last Updated: ${new Date(flat.lastUpdated).toLocaleString()}\n\n`;
              }

              const backKeyboard = {
                inline_keyboard: [
                  [
                    { text: '🔙 Back to Flat Management', callback_data: 'manage_flats' }
                  ]
                ]
              };

              await this.bot.sendMessage(chatId, message, { reply_markup: backKeyboard });
            } catch (error) {
              console.error('Error viewing flats:', error);
              await this.bot.sendMessage(chatId, '❌ Error retrieving flat information. Please try again.');
            }
            break;

          case 'add_flat':
            this.userStates.set(chatId, {
              type: 'flat_info',
              pendingQuestions: [
                'Enter flat number:',
                'Enter floor number:',
                'Enter owner name:',
                'Enter maintenance amount:',
                'Enter phone number:',
                'Is the flat occupied? (yes/no):',
                'If occupied, enter tenant name (or press skip):',
                'Enter email (or press skip):'
              ]
            });
            await this.bot.sendMessage(chatId, 'Enter flat number:');
            break;

          case 'collect_maintenance':
            try {
              const currentDate = new Date();
              const collectionType: CollectionSheet = {
                type: 'maintenance',
                month: currentDate.toLocaleString('default', { month: 'long' }),
                year: currentDate.getFullYear()
              };
              
              // Initialize maintenance collection sheet first
              await this.googleSheetsService.initializeCollection(collectionType, 0);
              
              const flats = await this.googleSheetsService.getAllFlats();
              const currentQuarter = Math.floor(currentDate.getMonth() / 3) + 1;

              let message = `💰 Maintenance Collection - Q${currentQuarter} ${currentDate.getFullYear()}\n\n`;
              let totalExpected = 0;

              for (const flat of flats) {
                totalExpected += flat.maintenanceAmount;
                message += `Flat ${flat.flatNumber}:\n`;
                message += `Owner: ${flat.ownerName}\n`;
                message += `Amount: ₹${flat.maintenanceAmount.toLocaleString('en-IN')}\n`;
                message += `Phone: ${flat.phoneNumber}\n\n`;
              }

              message += `\nTotal Expected: ₹${totalExpected.toLocaleString('en-IN')}`;

              const maintenanceKeyboard = {
                inline_keyboard: [
                  [
                    { text: '📝 Update Payment Status', callback_data: 'update_payment_status' },
                    { text: '📊 Collection Report', callback_data: 'collection_report' }
                  ],
                  [
                    { text: '🔙 Back to Main Menu', callback_data: 'main_menu' }
                  ]
                ]
              };

              await this.bot.sendMessage(chatId, message, { reply_markup: maintenanceKeyboard });
            } catch (error) {
              console.error('Error in collect_maintenance:', error);
              await this.bot.sendMessage(chatId, '❌ Error initializing maintenance collection. Please try again.');
            }
            break;

          case 'create_collection':
            const collectionKeyboard = {
              inline_keyboard: [
                [
                  { text: '💧 Water Bill', callback_data: 'create_water_collection' },
                  { text: '🔧 Maintenance', callback_data: 'create_maintenance_collection' }
                ],
                [
                  { text: '📝 Other Collection', callback_data: 'create_other_collection' }
                ],
                [
                  { text: '📊 View Existing Collections', callback_data: 'view_collections' }
                ],
                [
                  { text: '🔙 Back to Main Menu', callback_data: 'main_menu' }
                ]
              ]
            };

            await this.bot.sendMessage(
              chatId,
              '📋 Create New Collection\n\n' +
              'Select the type of collection to create:',
              { reply_markup: collectionKeyboard }
            );
            break;

          case 'view_collections':
            try {
              const collections = await this.googleSheetsService.getAllCollections();
              if (!collections || collections.length === 0) {
                await this.bot.sendMessage(chatId, 'No collections found.');
                return;
              }

              const keyboard = {
                inline_keyboard: collections.map(collection => [{
                  text: `${collection.type === 'other' ? collection.description : collection.type.charAt(0).toUpperCase() + collection.type.slice(1)} - ${collection.month} ${collection.year}`,
                  callback_data: `view_collection_${collection.type}_${collection.month}_${collection.year}`
                }])
              };

              // Add back button
              keyboard.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'create_collection' }]);

              await this.bot.sendMessage(
                chatId,
                'Select a collection to view or update:',
                { reply_markup: keyboard }
              );
            } catch (error) {
              console.error('Error viewing collections:', error);
              await this.bot.sendMessage(chatId, '❌ Error retrieving collections. Please try again.');
            }
            break;

          case 'create_water_collection':
            this.userStates.set(chatId, {
              type: 'collection_info',
              pendingQuestions: [
                'Enter the amount per flat:',
                'Enter any additional description (or press skip):'
              ],
              collectionType: {
                type: 'water',
                month: new Date().toLocaleString('default', { month: 'long' }),
                year: new Date().getFullYear()
              }
            });
            await this.bot.sendMessage(chatId, 'Enter the amount per flat:');
            break;

          case 'create_other_collection':
            this.userStates.set(chatId, {
              type: 'collection_info',
              pendingQuestions: [
                'Enter collection name:',
                'Enter the amount per flat:',
                'Enter any additional description (or press skip):'
              ],
              collectionType: {
                type: 'other',
                month: new Date().toLocaleString('default', { month: 'long' }),
                year: new Date().getFullYear()
              }
            });
            await this.bot.sendMessage(chatId, 'Enter collection name:');
            break;

          case 'main_menu':
            const mainKeyboard = {
              inline_keyboard: [
                [
                  { text: '➕ Add Expense', callback_data: 'add_expense' },
                  { text: '➕ Add Income', callback_data: 'add_income' }
                ],
                [
                  { text: '📊 Monthly Report', callback_data: 'monthly_report' },
                  { text: '📈 Quarterly Report', callback_data: 'quarterly_report' }
                ],
                [
                  { text: '🏢 Manage Flats', callback_data: 'manage_flats' },
                  { text: '💰 Collect Maintenance', callback_data: 'collect_maintenance' }
                ],
                [
                  { text: '📋 Create Collection', callback_data: 'create_collection' }
                ]
              ]
            };

            await this.bot.sendMessage(
              chatId,
              'Welcome to the Flat Association Expense Bot! 🏢\n\n' +
              'Please select an option:',
              { reply_markup: mainKeyboard }
            );
            break;

          case 'maintenance_collection':
            await this.handleCollectionInfoInput(chatId, {
              type: 'collection_info',
              collectionType: {
                type: 'maintenance',
                month: new Date().toLocaleString('default', { month: 'long' }),
                year: new Date().getFullYear()
              }
            }, '');
            break;

          case 'update_payment_status':
            await this.handleUpdatePaymentStatus(chatId);
            break;

          case 'view_collection_':
            const viewParts = data.split('_');
            const viewType = viewParts[2];
            const viewMonth = viewParts[3];
            const viewYear = parseInt(viewParts[4]);
            
            const viewCollectionType: CollectionSheet = {
              type: viewType as 'maintenance' | 'water' | 'other',
              month: viewMonth,
              year: viewYear
            };
            
            try {
              const collection = await this.googleSheetsService.getCollection(viewCollectionType);
              if (!collection || collection.length === 0) {
                await this.bot.sendMessage(chatId, 'No data found for this collection.');
                return;
              }

              let message = `📋 ${viewType === 'other' ? collection[0].description : viewType.charAt(0).toUpperCase() + viewType.slice(1)} Collection - ${viewMonth} ${viewYear}\n\n`;
              
              const totalAmount = collection.reduce((sum, item) => sum + item.amount, 0);
              const paidAmount = collection
                .filter(item => item.status === 'Paid')
                .reduce((sum, item) => sum + item.amount, 0);
              
              message += `Total Amount: ₹${totalAmount.toLocaleString('en-IN')}\n`;
              message += `Paid Amount: ₹${paidAmount.toLocaleString('en-IN')}\n`;
              message += `Pending Amount: ₹${(totalAmount - paidAmount).toLocaleString('en-IN')}\n\n`;
              
              message += 'Flat-wise Status:\n\n';
              collection.forEach(item => {
                message += `Flat ${item.flatNumber} (${item.ownerName})\n`;
                message += `Amount: ₹${item.amount.toLocaleString('en-IN')}\n`;
                message += `Status: ${item.status === 'Paid' ? '✅ Paid' : '⏳ Pending'}\n`;
                if (item.status === 'Paid' && item.paymentDate) {
                  message += `Payment Date: ${item.paymentDate}\n`;
                  message += `Marked by: ${item.markedBy || 'Unknown'}\n`;
                }
                message += '\n';
              });

              const keyboard = {
                inline_keyboard: [
                  [{ text: '📝 Update Payment Status', callback_data: `update_collection_${viewType}_${viewMonth}_${viewYear}` }],
                  [{ text: '🔙 Back to Collections', callback_data: 'view_collections' }]
                ]
              };

              await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
            } catch (error) {
              console.error('Error viewing collection:', error);
              await this.bot.sendMessage(chatId, '❌ Error retrieving collection data. Please try again.');
            }
            break;

          case 'update_collection_':
            const updateParts = data.split('_');
            const updateType = updateParts[2];
            const updateMonth = updateParts[3];
            const updateYear = parseInt(updateParts[4]);
            
            const updateCollectionType: CollectionSheet = {
              type: updateType as 'maintenance' | 'water' | 'other',
              month: updateMonth,
              year: updateYear
            };
            
            try {
              const collection = await this.googleSheetsService.getCollection(updateCollectionType);
              if (!collection || collection.length === 0) {
                await this.bot.sendMessage(chatId, 'No data found for this collection.');
                return;
              }

              // Create keyboard with flat options
              const keyboard = {
                inline_keyboard: collection.map(item => [{
                  text: `Flat ${item.flatNumber} (${item.status === 'Paid' ? '✅' : '⏳'})`,
                  callback_data: `update_flat_${item.flatNumber}_${updateType}_${updateMonth}_${updateYear}`
                }])
              };

              // Add back button
              keyboard.inline_keyboard.push([{ text: '🔙 Back', callback_data: `view_collection_${updateType}_${updateMonth}_${updateYear}` }]);

              await this.bot.sendMessage(
                chatId,
                'Select a flat to update its payment status:',
                { reply_markup: keyboard }
              );
            } catch (error) {
              console.error('Error handling update collection:', error);
              await this.bot.sendMessage(chatId, 'An error occurred while fetching collection data.');
            }
            break;
        }
      }

      // Answer the callback query to remove the loading state
      await this.bot.answerCallbackQuery(callbackQuery.id);
    });

    // Handle photo messages
    this.bot.on('photo', async (msg) => {
      if (!msg.from) {
        await this.bot.sendMessage(msg.chat.id, 'Error: Could not identify user.');
        return;
      }

      // Check if user is authorized
      if (!this.isUserAuthorized(msg.from.id)) {
        await this.handleUnauthorizedUser(msg.chat.id, msg.from);
        return;
      }

      // Log authorized access
      await this.logAccessAttempt(msg.from, true);

      await this.handlePhotoMessage(msg);
    });

    // Handle text messages
    this.bot.on('message', async (msg) => {
      if (!msg.from) {
        await this.bot.sendMessage(msg.chat.id, 'Error: Could not identify user.');
        return;
      }

      // Check if user is authorized
      if (!this.isUserAuthorized(msg.from.id)) {
        await this.handleUnauthorizedUser(msg.chat.id, msg.from);
        return;
      }

      // Log authorized access
      await this.logAccessAttempt(msg.from, true);

      await this.handleTextMessage(msg);
    });

    // Add handler for flat payment updates
    this.bot.on('callback_query', async (callbackQuery) => {
      if (!callbackQuery.data || !callbackQuery.message || !callbackQuery.from) {
        return;
      }
      const data = callbackQuery.data;
      if (data.startsWith('update_flat_')) {
        const flatNumber = data.replace('update_flat_', '');
        const username = `${callbackQuery.from.first_name}${callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : ''}`;
        await this.handleFlatPaymentUpdate(callbackQuery.message.chat.id, flatNumber, username);
      }
    });
  }

  private async handlePhotoMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    if (!msg.photo || msg.photo.length === 0) {
      await this.bot.sendMessage(chatId, 'No photo received. Please try again.');
      return;
    }

    // Check if user state exists
    const userState = this.userStates.get(chatId);
    if (!userState) {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '➕ Add Expense', callback_data: 'add_expense' },
            { text: '➕ Add Income', callback_data: 'add_income' }
          ]
        ]
      };
      await this.bot.sendMessage(
        chatId,
        'Please select whether this is an expense or income:',
        { reply_markup: keyboard }
      );
      return;
    }
    
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;
    let driveUrl: string;
    
    try {
      // Send processing message
      await this.bot.sendMessage(chatId, 'Processing your receipt... 📝');
      
      const file = await this.bot.getFile(fileId);
      const imageUrl = `https://api.telegram.org/file/bot${this.configService.get('TELEGRAM_BOT_TOKEN')}/${file.file_path}`;
      
      // Upload image to Google Drive
      await this.bot.sendMessage(chatId, 'Uploading receipt to Google Drive... 📤');
      const fileName = `receipt_${Date.now()}.jpg`;
      try {
        driveUrl = await this.googleDriveService.uploadImage(imageUrl, fileName);
        
        // Update user state with receipt URL immediately after upload
        this.userStates.set(chatId, {
          ...userState,
          receiptUrl: driveUrl,
        });
      } catch (driveError) {
        console.error('Google Drive upload error:', driveError);
        Sentry.captureException(driveError, {
          extra: {
            chatId,
            fileId,
            imageUrl,
            fileName,
          },
        });
        throw new Error('Failed to upload image to Google Drive');
      }
      
      // Process image with OCR
      await this.bot.sendMessage(chatId, 'Extracting text from image... 🔍');
      let text: string;
      try {
        const worker = await createWorker();
        const { data: { text: ocrText } } = await worker.recognize(imageUrl);
        await worker.terminate();
        text = ocrText;
      } catch (ocrError) {
        console.error('OCR processing error:', ocrError);
        Sentry.captureException(ocrError, {
          extra: {
            chatId,
            fileId,
            imageUrl,
          },
        });
        throw new Error('Failed to process image with OCR');
      }

      if (!text || text.trim().length === 0) {
        await this.bot.sendMessage(chatId, '❌ Could not extract any text from the image. Please try again with a clearer image or enter the details manually.');
        return;
      }

      // Extract information using Gemini AI
      await this.bot.sendMessage(chatId, 'Analyzing the extracted text... 🤖');
      try {
        const extractedInfo = await this.extractInfoFromText(text);
        
        // Set the type from user state
        if (userState.type === 'expense' || userState.type === 'income') {
          extractedInfo.type = userState.type;
        }
        
        // Get the current user state to ensure we have the receipt URL
        const currentState = this.userStates.get(chatId);
        
        if (extractedInfo.confidence > 0.7) {
          await this.confirmAndSaveEntry(chatId, extractedInfo);
        } else {
          await this.askFollowUpQuestions(chatId, extractedInfo);
        }
      } catch (geminiError) {
        console.error('Gemini AI processing error:', geminiError);
        Sentry.captureException(geminiError, {
          extra: {
            chatId,
            text,
          },
        });
        await this.bot.sendMessage(
          chatId,
          '❌ Error analyzing the text. Please try entering the details manually using the format:\nAmount, Category, Description'
        );
      }
    } catch (error) {
      console.error('Overall error processing receipt:', error);
      Sentry.captureException(error, {
        extra: {
          chatId,
          fileId,
        },
      });
      let errorMessage = '❌ Error processing your receipt. ';
      
      if (error instanceof Error) {
        if (error.message.includes('Failed to extract information')) {
          errorMessage += error.message;
        } else {
          errorMessage += 'Please try entering the details manually using the format:\nAmount, Category, Description';
        }
      }
      
      await this.bot.sendMessage(chatId, errorMessage);
    }
  }

  private async handleTextMessage(msg: TelegramBot.Message) {
    if (!msg.text || msg.text.startsWith('/')) {
      return;
    }

    const chatId = msg.chat.id;
    const text = msg.text.toLowerCase();
    const userState = this.userStates.get(chatId);

    // Handle greetings
    if (['hi', 'hello', 'hey', 'start'].includes(text)) {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '➕ Add Expense', callback_data: 'add_expense' },
            { text: '➕ Add Income', callback_data: 'add_income' }
          ],
          [
            { text: '📊 Monthly Report', callback_data: 'monthly_report' },
            { text: '📈 Quarterly Report', callback_data: 'quarterly_report' }
          ],
          [
            { text: '🏢 Manage Flats', callback_data: 'manage_flats' },
            { text: '💰 Collect Maintenance', callback_data: 'collect_maintenance' }
          ],
          [
            { text: '📋 Create Collection', callback_data: 'create_collection' }
          ]
        ]
      };

      await this.bot.sendMessage(
        chatId,
        'Welcome to the Flat Association Expense Bot! 🏢\n\n' +
        'Please select an option:',
        { reply_markup: keyboard }
      );
      return;
    }

    if (!userState) {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '➕ Add Expense', callback_data: 'add_expense' },
            { text: '➕ Add Income', callback_data: 'add_income' }
          ]
        ]
      };
      await this.bot.sendMessage(
        chatId,
        'Please select whether this is an expense or income:',
        { reply_markup: keyboard }
      );
      return;
    }

    // Handle flat info input
    if (userState.type === 'flat_info') {
      await this.handleFlatInfoInput(chatId, userState, text);
      return;
    }

    // Handle collection info input
    if (userState.type === 'collection_info') {
      await this.handleCollectionInfoInput(chatId, userState, text);
      return;
    }

    // Handle confirmation
    if (text === 'yes' && userState.extractedInfo && this.isExtractedInfo(userState.extractedInfo)) {
      try {
        const entry = {
          amount: userState.extractedInfo.amount || 0,
          category: userState.extractedInfo.category || '',
          description: userState.extractedInfo.description || '',
          date: userState.extractedInfo.date || new Date().toISOString().split('T')[0],
          type: this.getEntryType(userState.type),
          receiptUrl: userState.receiptUrl || '',
          addedBy: userState.userName || 'Unknown',
        };
        await this.googleSheetsService.addEntry(entry);
        await this.bot.sendMessage(chatId, 'Entry added successfully! ✅');
        this.userStates.delete(chatId);
      } catch (error) {
        console.error('Error saving entry:', error);
        Sentry.captureException(error, {
          extra: {
            chatId,
            entry: userState.extractedInfo,
            receiptUrl: userState.receiptUrl,
          },
        });
        await this.bot.sendMessage(chatId, 'Error adding entry. Please try again.');
      }
      return;
    }

    if (text === 'no' && userState.extractedInfo && this.isExtractedInfo(userState.extractedInfo)) {
      await this.askFollowUpQuestions(chatId, userState.extractedInfo);
      return;
    }

    // Handle follow-up questions
    if (userState.pendingQuestions && userState.pendingQuestions.length > 0) {
      const currentQuestion = userState.pendingQuestions[0];
      const answer = text.trim();
      const remainingQuestions = userState.pendingQuestions.slice(1);
      
      // Update the extracted info based on the answer
      const updatedInfo: ExtractedInfo = { 
        ...(this.isExtractedInfo(userState.extractedInfo) ? userState.extractedInfo : {}),
        confidence: this.isExtractedInfo(userState.extractedInfo) ? userState.extractedInfo.confidence : 0
      };

      if (currentQuestion.includes('amount')) {
        updatedInfo.amount = parseFloat(answer);
      } else if (currentQuestion.includes('category')) {
        updatedInfo.category = answer;
      } else if (currentQuestion.includes('description')) {
        updatedInfo.description = answer;
      } else if (currentQuestion.includes('date')) {
        updatedInfo.date = answer;
      }

      this.userStates.set(chatId, {
        type: userState.type,
        extractedInfo: updatedInfo,
        pendingQuestions: remainingQuestions,
        receiptUrl: userState.receiptUrl,
        userName: userState.userName,
      });

      if (remainingQuestions.length > 0) {
        await this.bot.sendMessage(chatId, remainingQuestions[0]);
      } else {
        await this.confirmAndSaveEntry(chatId, updatedInfo);
      }
      return;
    }

    // Handle manual entry
    if (text.includes(',')) {
      const [amount, category, description] = text.split(',').map(item => item.trim());
      const entry: ExtractedInfo = {
        amount: parseFloat(amount),
        category,
        description,
        date: new Date().toISOString().split('T')[0],
        type: this.getEntryType(userState.type),
        confidence: 1
      };
      
      await this.confirmAndSaveEntry(chatId, entry);
    }
  }

  private async handleCollectionInfoInput(chatId: number, userState: UserState, text: string) {
    if (!userState.pendingQuestions || userState.pendingQuestions.length === 0) {
      return;
    }

    const currentQuestion = userState.pendingQuestions[0];
    const answer = text.trim();
    const remainingQuestions = userState.pendingQuestions.slice(1);
    const collectionType = userState.collectionType as CollectionSheet;

    if (currentQuestion.includes('amount')) {
      const amount = parseFloat(answer);
      if (isNaN(amount) || amount <= 0) {
        await this.bot.sendMessage(chatId, '❌ Please enter a valid amount greater than 0.');
        return;
      }

      try {
        await this.googleSheetsService.initializeCollection(collectionType, amount);
        await this.bot.sendMessage(chatId, '✅ Collection sheet created successfully!');
        
        // Show collection details
        const collection = await this.googleSheetsService.getCollection(collectionType);
        let message = `📋 ${collectionType.type === 'other' ? collectionType.description : collectionType.type.charAt(0).toUpperCase() + collectionType.type.slice(1)} Collection - ${collectionType.month} ${collectionType.year}\n\n`;
        
        const totalAmount = collection.reduce((sum, item) => sum + item.amount, 0);
        const paidAmount = collection
          .filter(item => item.status === 'Paid')
          .reduce((sum, item) => sum + item.amount, 0);
        
        message += `Total Amount: ₹${totalAmount.toLocaleString('en-IN')}\n`;
        message += `Paid Amount: ₹${paidAmount.toLocaleString('en-IN')}\n`;
        message += `Pending Amount: ₹${(totalAmount - paidAmount).toLocaleString('en-IN')}\n\n`;
        
        message += 'Flat-wise Status:\n\n';
        collection.forEach(item => {
          message += `Flat ${item.flatNumber} (${item.ownerName})\n`;
          message += `Amount: ₹${item.amount.toLocaleString('en-IN')}\n`;
          message += `Status: ${item.status === 'Paid' ? '✅ Paid' : '⏳ Pending'}\n\n`;
        });

        const keyboard = {
          inline_keyboard: [
            [{ text: '📝 Update Payment Status', callback_data: 'update_payment_status' }],
            [{ text: '🔙 Back to Main Menu', callback_data: 'main_menu' }]
          ]
        };

        await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
        this.userStates.delete(chatId);
      } catch (error) {
        console.error('Error creating collection:', error);
        await this.bot.sendMessage(chatId, '❌ Error creating collection sheet. Please try again.');
      }
    } else if (currentQuestion.includes('name')) {
      // For other collections, store the name in description
      collectionType.description = answer;
      if (remainingQuestions.length > 0) {
        this.userStates.set(chatId, {
          ...userState,
          pendingQuestions: remainingQuestions,
          collectionType
        });
        await this.bot.sendMessage(chatId, remainingQuestions[0]);
      }
    } else if (currentQuestion.includes('description')) {
      if (answer.toLowerCase() !== 'skip') {
        collectionType.description = answer;
      }
      if (remainingQuestions.length > 0) {
        this.userStates.set(chatId, {
          ...userState,
          pendingQuestions: remainingQuestions,
          collectionType
        });
        await this.bot.sendMessage(chatId, remainingQuestions[0]);
      }
    }
  }

  private async handleUpdatePaymentStatus(chatId: number) {
    try {
      const currentDate = new Date();
      const collectionType: CollectionSheet = {
        type: 'maintenance',
        month: currentDate.toLocaleString('default', { month: 'long' }),
        year: currentDate.getFullYear()
      };
      
      const collection = await this.googleSheetsService.getCollection(collectionType);
      
      if (collection.length === 0) {
        await this.bot.sendMessage(chatId, 'No collection data available.');
        return;
      }

      // Create keyboard with flat options
      const keyboard = {
        inline_keyboard: collection.map(item => [{
          text: `Flat ${item.flatNumber} (${item.status === 'Paid' ? '✅' : '⏳'})`,
          callback_data: `update_flat_${item.flatNumber}`
        }])
      };

      // Add back button
      keyboard.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'maintenance_collection' }]);

      await this.bot.sendMessage(
        chatId,
        'Select a flat to update its payment status:',
        { reply_markup: keyboard }
      );
    } catch (error) {
      console.error('Error handling update payment status:', error);
      await this.bot.sendMessage(chatId, 'An error occurred while fetching flat data.');
    }
  }

  private async handleFlatPaymentUpdate(chatId: number, flatNumber: string, username: string, collectionType?: CollectionSheet) {
    try {
      if (!collectionType) {
        const currentDate = new Date();
        collectionType = {
          type: 'maintenance',
          month: currentDate.toLocaleString('default', { month: 'long' }),
          year: currentDate.getFullYear()
        };
      }
      
      const collection = await this.googleSheetsService.getCollection(collectionType);
      const flat = collection.find(item => item.flatNumber === flatNumber);

      if (!flat) {
        await this.bot.sendMessage(chatId, 'Flat not found in collection.');
        return;
      }

      const newStatus = flat.status === 'Paid' ? 'Pending' : 'Paid';
      await this.googleSheetsService.updateCollectionStatus(collectionType, flatNumber, newStatus, username);

      // Show updated status
      const message = `Payment status updated for Flat ${flatNumber}:\n\n` +
        `Owner: ${flat.ownerName}\n` +
        `Amount: ₹${flat.amount.toLocaleString('en-IN')}\n` +
        `New Status: ${newStatus === 'Paid' ? '✅ Paid' : '⏳ Pending'}\n` +
        (newStatus === 'Paid' ? `Payment Date: ${new Date().toISOString().split('T')[0]}\n` : '');

      const keyboard = {
        inline_keyboard: [
          [{ text: '🔄 Update Another Flat', callback_data: `update_collection_${collectionType.type}_${collectionType.month}_${collectionType.year}` }],
          [{ text: '🔙 Back to Collection', callback_data: `view_collection_${collectionType.type}_${collectionType.month}_${collectionType.year}` }]
        ]
      };

      await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
    } catch (error) {
      console.error('Error handling flat payment update:', error);
      await this.bot.sendMessage(chatId, 'An error occurred while updating payment status.');
    }
  }
} 