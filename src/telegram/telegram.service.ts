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

interface UserState {
  type: 'expense' | 'income';
  extractedInfo?: ExtractedInfo;
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
      type: userState.type,
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
      }

      // Answer the callback query to remove the loading state
      await this.bot.answerCallbackQuery(callbackQuery.id);
    });

    // Handle photo messages
    this.bot.on('photo', async (msg) => {
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
          extractedInfo.type = userState.type;
          
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
    });

    // Handle text messages
    this.bot.on('message', async (msg) => {
      if (msg.text && !msg.text.startsWith('/')) {
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

        // Handle confirmation
        if (text === 'yes' && userState.extractedInfo) {
          try {
            console.log('User confirmed entry. Current user state:', userState);
            const entry = {
              amount: userState.extractedInfo.amount || 0,
              category: userState.extractedInfo.category || '',
              description: userState.extractedInfo.description || '',
              date: userState.extractedInfo.date || new Date().toISOString().split('T')[0],
              type: userState.type,
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

        if (text === 'no' && userState.extractedInfo) {
          await this.askFollowUpQuestions(chatId, userState.extractedInfo);
          return;
        }

        // Handle follow-up questions
        if (userState.pendingQuestions && userState.pendingQuestions.length > 0) {
          const currentQuestion = userState.pendingQuestions[0];
          const remainingQuestions = userState.pendingQuestions.slice(1);
          
          // Update the extracted info based on the answer
          const updatedInfo: ExtractedInfo = { 
            ...userState.extractedInfo,
            confidence: userState.extractedInfo?.confidence || 0
          };

          if (currentQuestion.includes('amount')) {
            updatedInfo.amount = parseFloat(text);
          } else if (currentQuestion.includes('category')) {
            updatedInfo.category = text;
          } else if (currentQuestion.includes('description')) {
            updatedInfo.description = text;
          } else if (currentQuestion.includes('date')) {
            updatedInfo.date = text;
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
            type: userState.type,
            confidence: 1
          };
          
          await this.confirmAndSaveEntry(chatId, entry);
        }
      }
    });
  }
} 