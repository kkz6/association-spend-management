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

type UserStateType = 'expense' | 'income' | 'flat_info';

interface UserState {
  type: UserStateType;
  extractedInfo?: ExtractedInfo | FlatInfo;
  pendingQuestions?: string[];
  receiptUrl?: string;
  userName?: string;
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
  }

  async onModuleInit() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not defined');
    }
    this.bot = new TelegramBot(token, { polling: true });
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
    return type === 'flat_info' ? 'expense' : type;
  }

  private async handleFlatInfoInput(chatId: number, userState: UserState, text: string) {
    if (!userState.pendingQuestions || userState.pendingQuestions.length === 0) {
      console.log('No pending questions found');
      return;
    }

    const currentQuestion = userState.pendingQuestions[0];
    const answer = text.trim();
    const remainingQuestions = userState.pendingQuestions.slice(1);

    console.log('Current question:', currentQuestion);
    console.log('Answer:', answer);
    console.log('Remaining questions:', remainingQuestions);

    // Initialize flatInfo first
    let flatInfo: Partial<FlatInfo>;
    if (this.isFlatInfo(userState.extractedInfo)) {
      flatInfo = { ...userState.extractedInfo };
    } else {
      flatInfo = {};
    }

    // Handle skip command
    if (answer.toLowerCase() === 'skip') {
      console.log('Skip command detected');
      
      // For required fields, don't allow skipping
      if (currentQuestion.includes('flat number') || 
          currentQuestion.includes('floor number') || 
          currentQuestion.includes('owner name') || 
          currentQuestion.includes('maintenance amount') || 
          currentQuestion.includes('phone number') || 
          currentQuestion.includes('occupied')) {
        console.log('Attempted to skip required field');
        await this.bot.sendMessage(chatId, '❌ This field is required. Please provide a value.');
        return;
      }

      console.log('Skipping optional field');
      // For optional fields, proceed to next question
      if (remainingQuestions.length > 0) {
        console.log('Moving to next question:', remainingQuestions[0]);
        await this.bot.sendMessage(chatId, remainingQuestions[0]);
        
        // Update state with remaining questions
        const newState: UserState = {
          type: 'flat_info',
          extractedInfo: flatInfo as FlatInfo,
          pendingQuestions: remainingQuestions,
          userName: userState.userName
        };
        
        console.log('Updating state with:', newState);
        this.userStates.set(chatId, newState);
      } else {
        console.log('No more questions, attempting to save');
        // If this was the last question, try to save with available information
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

    console.log('Updated flatInfo:', flatInfo);

    if (remainingQuestions.length > 0) {
      console.log('Moving to next question:', remainingQuestions[0]);
      await this.bot.sendMessage(chatId, remainingQuestions[0]);
      
      // Update state with remaining questions
      const newState: UserState = {
        type: 'flat_info',
        extractedInfo: flatInfo as FlatInfo,
        pendingQuestions: remainingQuestions,
        userName: userState.userName
      };
      
      console.log('Updating state with:', newState);
      this.userStates.set(chatId, newState);
    } else {
      console.log('No more questions, attempting to save');
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

    // Handle callback queries (button clicks)
    this.bot.on('callback_query', async (callbackQuery) => {
      if (!callbackQuery.message) {
        await this.bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Error: Invalid message'
        });
        return;
      }

      const chatId = callbackQuery.message.chat.id;
      const data = callbackQuery.data;

      if (!callbackQuery.from) {
        await this.bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Error: Could not identify user'
        });
        return;
      }

      // Store user's name if not already stored
      const currentState = this.userStates.get(chatId);
      const userState: UserState = {
        type: currentState?.type || 'expense',
        userName: currentState?.userName || `${callbackQuery.from.first_name}${callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : ''}`,
        extractedInfo: currentState?.extractedInfo,
        pendingQuestions: currentState?.pendingQuestions,
        receiptUrl: currentState?.receiptUrl
      };

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
            // Initialize maintenance collection sheet first
            await this.googleSheetsService.initializeMaintenanceCollection();
            
            const flats = await this.googleSheetsService.getAllFlats();
            const currentDate = new Date();
            const currentQuarter = Math.floor(currentDate.getMonth() / 3) + 1;
            const currentYear = currentDate.getFullYear();

            let message = `💰 Maintenance Collection - Q${currentQuarter} ${currentYear}\n\n`;
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
          await this.handleMaintenanceCollection(chatId);
          break;

        case 'update_payment_status':
          await this.handleUpdatePaymentStatus(chatId);
          break;
      }

      // Answer the callback query to remove the loading state
      await this.bot.answerCallbackQuery(callbackQuery.id);
    });

    // Handle photo messages
    this.bot.on('photo', async (msg) => {
      await this.handlePhotoMessage(msg);
    });

    // Handle text messages
    this.bot.on('message', async (msg) => {
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
        console.log('Successfully uploaded to Google Drive:', driveUrl);
        
        // Update user state with receipt URL immediately after upload
        this.userStates.set(chatId, {
          ...userState,
          receiptUrl: driveUrl,
        });
        console.log('Updated user state with receipt URL:', this.userStates.get(chatId));
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
        console.log('OCR extracted text:', text);
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
        console.log('No text extracted from image');
        await this.bot.sendMessage(chatId, '❌ Could not extract any text from the image. Please try again with a clearer image or enter the details manually.');
        return;
      }

      // Extract information using Gemini AI
      await this.bot.sendMessage(chatId, 'Analyzing the extracted text... 🤖');
      try {
        const extractedInfo = await this.extractInfoFromText(text);
        console.log('Gemini AI extracted info:', extractedInfo);
        
        // Set the type from user state
        if (userState.type !== 'flat_info') {
          extractedInfo.type = userState.type;
        }
        
        // Get the current user state to ensure we have the receipt URL
        const currentState = this.userStates.get(chatId);
        console.log('Current user state before confirmation:', currentState);
        
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
            { text: '📈 Quarterly Report', callback_data: 'quarterly_report' },
            { text: '🏢 Manage Flats', callback_data: 'manage_flats' },
            { text: '💰 Collect Maintenance', callback_data: 'collect_maintenance' }
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

    // Handle confirmation
    if (text === 'yes' && userState.extractedInfo && this.isExtractedInfo(userState.extractedInfo)) {
      try {
        console.log('User confirmed entry. Current user state:', userState);
        const entry = {
          amount: userState.extractedInfo.amount || 0,
          category: userState.extractedInfo.category || '',
          description: userState.extractedInfo.description || '',
          date: userState.extractedInfo.date || new Date().toISOString().split('T')[0],
          type: this.getEntryType(userState.type),
          receiptUrl: userState.receiptUrl || '',
          addedBy: userState.userName || 'Unknown',
        };
        console.log('Saving entry with receipt URL:', entry.receiptUrl);
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

  private async handleMaintenanceCollection(chatId: number) {
    try {
      // Initialize maintenance collection if not already done
      await this.googleSheetsService.initializeMaintenanceCollection();
      
      // Get current maintenance collection
      const collection = await this.googleSheetsService.getMaintenanceCollection();
      
      if (collection.length === 0) {
        await this.bot.sendMessage(chatId, 'No maintenance collection data available.');
        return;
      }

      // Calculate totals
      const totalAmount = collection.reduce((sum, item) => sum + item.amount, 0);
      const paidAmount = collection
        .filter(item => item.status === 'Paid')
        .reduce((sum, item) => sum + item.amount, 0);
      const pendingAmount = totalAmount - paidAmount;

      // Create message with collection details
      let message = '📊 *Maintenance Collection Status*\n\n';
      message += `Total Amount: ₹${totalAmount.toLocaleString('en-IN')}\n`;
      message += `Paid Amount: ₹${paidAmount.toLocaleString('en-IN')}\n`;
      message += `Pending Amount: ₹${pendingAmount.toLocaleString('en-IN')}\n\n`;
      message += '*Flat-wise Status:*\n\n';

      collection.forEach(item => {
        message += `*Flat ${item.flatNumber}* (${item.ownerName})\n`;
        message += `Amount: ₹${item.amount.toLocaleString('en-IN')}\n`;
        message += `Status: ${item.status === 'Paid' ? '✅ Paid' : '⏳ Pending'}\n`;
        if (item.status === 'Paid' && item.paymentDate) {
          message += `Payment Date: ${item.paymentDate}\n`;
        }
        message += '\n';
      });

      // Create inline keyboard for updating payment status
      const keyboard = {
        inline_keyboard: [
          [{ text: '📝 Update Payment Status', callback_data: 'update_payment_status' }],
          [{ text: '🔙 Back to Main Menu', callback_data: 'main_menu' }]
        ]
      };

      await this.bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (error) {
      console.error('Error handling maintenance collection:', error);
      await this.bot.sendMessage(chatId, 'An error occurred while fetching maintenance collection data.');
    }
  }

  private async handleUpdatePaymentStatus(chatId: number) {
    try {
      const collection = await this.googleSheetsService.getMaintenanceCollection();
      
      if (collection.length === 0) {
        await this.bot.sendMessage(chatId, 'No maintenance collection data available.');
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

  private async handleFlatPaymentUpdate(chatId: number, flatNumber: string, username: string) {
    try {
      const collection = await this.googleSheetsService.getMaintenanceCollection();
      const flat = collection.find(item => item.flatNumber === flatNumber);

      if (!flat) {
        await this.bot.sendMessage(chatId, 'Flat not found in maintenance collection.');
        return;
      }

      const newStatus = flat.status === 'Paid' ? 'Pending' : 'Paid';
      await this.googleSheetsService.updateMaintenanceStatus(flatNumber, newStatus, username);

      // Show updated status
      const message = `Payment status updated for Flat ${flatNumber}:\n\n` +
        `Owner: ${flat.ownerName}\n` +
        `Amount: ₹${flat.amount.toLocaleString('en-IN')}\n` +
        `New Status: ${newStatus === 'Paid' ? '✅ Paid' : '⏳ Pending'}\n` +
        (newStatus === 'Paid' ? `Payment Date: ${new Date().toISOString().split('T')[0]}\n` : '');

      const keyboard = {
        inline_keyboard: [
          [{ text: '🔄 Update Another Flat', callback_data: 'update_payment_status' }],
          [{ text: '🔙 Back to Collection', callback_data: 'maintenance_collection' }]
        ]
      };

      await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
    } catch (error) {
      console.error('Error handling flat payment update:', error);
      await this.bot.sendMessage(chatId, 'An error occurred while updating payment status.');
    }
  }
} 