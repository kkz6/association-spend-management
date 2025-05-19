import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as TelegramBot from 'node-telegram-bot-api';
import { GoogleSheetsService } from '../google-sheets/google-sheets.service';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createWorker, Worker, createScheduler } from 'tesseract.js';

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
      console.log('Sending request to Gemini API with model: gemini-2.0-flash');
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
      console.log('Received response from Gemini API');
      
      const response = await result.response;
      console.log('Response text:', response.text());
      
      const text = response.text().trim();
      // Remove any markdown formatting if present
      const cleanText = text.replace(/```json\n?|\n?```/g, '');
      console.log('Cleaned text:', cleanText);
      
      const extractedInfo = JSON.parse(cleanText) as ExtractedInfo;
      console.log('Parsed info:', extractedInfo);
      
      return extractedInfo;
    } catch (error) {
      console.error('Error extracting info:', error);
      if (error instanceof Error) {
        console.error('Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack
        });
      }
      throw new Error('Failed to extract information from the text. Please try entering the details manually.');
    }
  }

  private async askFollowUpQuestions(chatId: number, extractedInfo: ExtractedInfo) {
    const questions: string[] = [];
    const userState = this.userStates.get(chatId);
    if (!userState) return;

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
      });
      await this.bot.sendMessage(chatId, questions[0]);
    } else {
      await this.confirmAndSaveEntry(chatId, extractedInfo);
    }
  }

  private async confirmAndSaveEntry(chatId: number, info: ExtractedInfo) {
    const userState = this.userStates.get(chatId);
    if (!userState) return;

    const entry = {
      amount: info.amount || 0,
      category: info.category || '',
      description: info.description || '',
      date: info.date || new Date().toISOString().split('T')[0],
      type: userState.type,
    };

    const confirmationMessage = `Please confirm the following details:\n\n` +
      `Amount: ${entry.amount}\n` +
      `Category: ${entry.category}\n` +
      `Description: ${entry.description}\n` +
      `Date: ${entry.date}\n` +
      `Type: ${entry.type}\n\n` +
      `Is this correct? (yes/no)`;

    await this.bot.sendMessage(chatId, confirmationMessage);
    this.userStates.set(chatId, { 
      type: userState.type,
      extractedInfo: { ...info, confidence: info.confidence }
    });
  }

  private setupBotHandlers() {
    // Start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot.sendMessage(
        chatId,
        'Welcome to the Flat Association Expense Bot! 🏢\n\n' +
        'Available commands:\n' +
        '/expense - Add a new expense\n' +
        '/income - Add a new income\n' +
        '/report - Get monthly report\n' +
        '/quarterly - Get quarterly report\n' +
        '/upload - Upload receipt image'
      );
    });

    // Handle expense entry
    this.bot.onText(/\/expense/, async (msg) => {
      const chatId = msg.chat.id;
      this.userStates.set(chatId, { type: 'expense' });
      await this.bot.sendMessage(
        chatId,
        'Please enter the expense details in the following format:\n' +
        'Amount, Category, Description\n' +
        'Example: 1000, Maintenance, Monthly cleaning\n\n' +
        'Or upload a receipt image.'
      );
    });

    // Handle income entry
    this.bot.onText(/\/income/, async (msg) => {
      const chatId = msg.chat.id;
      this.userStates.set(chatId, { type: 'income' });
      await this.bot.sendMessage(
        chatId,
        'Please enter the income details in the following format:\n' +
        'Amount, Category, Description\n' +
        'Example: 5000, Dues, Monthly maintenance\n\n' +
        'Or upload a receipt image.'
      );
    });

    // Handle photo messages
    this.bot.on('photo', async (msg) => {
      const chatId = msg.chat.id;
      if (!msg.photo || msg.photo.length === 0) {
        await this.bot.sendMessage(chatId, 'No photo received. Please try again.');
        return;
      }
      
      const photo = msg.photo[msg.photo.length - 1];
      const fileId = photo.file_id;
      
      try {
        // Send processing message
        await this.bot.sendMessage(chatId, 'Processing your receipt... 📝');
        
        const file = await this.bot.getFile(fileId);
        const imageUrl = `https://api.telegram.org/file/bot${this.configService.get('TELEGRAM_BOT_TOKEN')}/${file.file_path}`;
        
        // Process image with OCR
        await this.bot.sendMessage(chatId, 'Extracting text from image... 🔍');
        const worker = await createWorker();
        const { data: { text } } = await worker.recognize(imageUrl);
        await worker.terminate();

        if (!text || text.trim().length === 0) {
          await this.bot.sendMessage(chatId, '❌ Could not extract any text from the image. Please try again with a clearer image or enter the details manually.');
          return;
        }

        // Extract information using Gemini AI
        await this.bot.sendMessage(chatId, 'Analyzing the extracted text... 🤖');
        const extractedInfo = await this.extractInfoFromText(text);
        
        if (extractedInfo.confidence > 0.7) {
          await this.confirmAndSaveEntry(chatId, extractedInfo);
        } else {
          await this.askFollowUpQuestions(chatId, extractedInfo);
        }
      } catch (error) {
        console.error('Error processing image:', error);
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

        if (!userState) {
          await this.bot.sendMessage(chatId, 'Please use /expense or /income command first.');
          return;
        }

        // Handle confirmation
        if (text === 'yes' && userState.extractedInfo) {
          try {
            const entry = {
              amount: userState.extractedInfo.amount || 0,
              category: userState.extractedInfo.category || '',
              description: userState.extractedInfo.description || '',
              date: userState.extractedInfo.date || new Date().toISOString().split('T')[0],
              type: userState.type,
            };
            await this.googleSheetsService.addEntry(entry);
            await this.bot.sendMessage(chatId, 'Entry added successfully! ✅');
            this.userStates.delete(chatId);
          } catch (error) {
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