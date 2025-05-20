import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import * as Sentry from '@sentry/node';

interface Entry {
  amount: number;
  category: string;
  description: string;
  date: string;
  type: 'expense' | 'income';
  receiptUrl?: string;
}

@Injectable()
export class GoogleSheetsService {
  private auth: JWT;
  private sheets: any;
  private readonly spreadsheetId: string;

  constructor(private configService: ConfigService) {
    this.initializeGoogleAuth();
    const sheetId = this.configService.get<string>('SPREADSHEET_ID');
    if (!sheetId) {
      throw new Error('SPREADSHEET_ID is not defined');
    }
    this.spreadsheetId = sheetId;
  }

  private async initializeGoogleAuth() {
    this.auth = new JWT({
      email: this.configService.get('GOOGLE_CLIENT_EMAIL'),
      key: this.configService.get('GOOGLE_PRIVATE_KEY'),
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
      ],
    });

    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
  }

  async addEntry(entry: Entry): Promise<void> {
    try {
      const sheet = await this.getOrCreateMonthlySheet();
      console.log('Adding entry to sheet:', { entry, sheet });
      
      // Ensure we have exactly 7 columns matching our header structure
      const values = [
        [
          entry.date,                                    // A: Date
          entry.type === 'expense' ? entry.amount : '',  // B: Expense
          entry.type === 'income' ? entry.amount : '',   // C: Income
          entry.category,                                // D: Category
          entry.description,                             // E: Description
          entry.receiptUrl || '',                        // F: Receipt URL
          new Date().toISOString(),                      // G: Timestamp
        ],
      ];

      console.log('Values to be added:', values);

      // First, get the current data to find the next row
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheet}!A:G`,
      });

      const currentData = response.data.values || [];
      const nextRow = currentData.length + 1;

      // Update the specific row instead of appending
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheet}!A${nextRow}:G${nextRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values,
        },
      });

      await this.updateTotals(sheet);
    } catch (error) {
      console.error('Error adding entry:', error);
      Sentry.captureException(error, {
        extra: { entry },
      });
      throw new Error('Failed to add entry to Google Sheets');
    }
  }

  private async getOrCreateMonthlySheet(): Promise<string> {
    try {
      const date = new Date();
      const month = date.toLocaleString('default', { month: 'long' });
      const year = date.getFullYear();
      const sheetName = `${month} ${year}`;

      // Check if sheet exists
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });

      const sheetExists = response.data.sheets?.some(
        (sheet) => sheet.properties?.title === sheetName,
      );

      if (!sheetExists) {
        // Create new sheet
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: sheetName,
                  },
                },
              },
            ],
          },
        });

        // Set up headers and totals row
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${sheetName}!A1:G2`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [
              [
                'Date',      // A
                'Expense',   // B
                'Income',    // C
                'Category',  // D
                'Description', // E
                'Receipt',   // F
                'Timestamp', // G
              ],
              [
                'Totals',
                '=SUM(B3:B)',
                '=SUM(C3:C)',
                '',
                '=B2-C2',
                '',
                '',
              ],
            ],
          },
        });

        // Format headers and totals row
        const sheetId = await this.getSheetId(response.data.sheets || [], sheetName);
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId,
                    startRowIndex: 0,
                    endRowIndex: 2,
                  },
                  cell: {
                    userEnteredFormat: {
                      backgroundColor: {
                        red: 0.8,
                        green: 0.8,
                        blue: 0.8,
                      },
                      textFormat: {
                        bold: true,
                      },
                    },
                  },
                  fields: 'userEnteredFormat(backgroundColor,textFormat)',
                },
              },
            ],
          },
        });
      }

      return sheetName;
    } catch (error) {
      console.error('Error getting or creating monthly sheet:', error);
      Sentry.captureException(error);
      throw new Error('Failed to get or create monthly sheet');
    }
  }

  private async updateTotals(sheetName: string) {
    try {
      // Get all values from the sheet
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A:G`,
      });

      const values = response.data.values || [];
      if (values.length <= 2) return; // Only headers and totals row

      // Calculate totals
      let totalExpense = 0;
      let totalIncome = 0;

      // Start from index 2 to skip headers and totals row
      for (let i = 2; i < values.length; i++) {
        const row = values[i];
        const expense = parseFloat(row[1]) || 0;
        const income = parseFloat(row[2]) || 0;

        totalExpense += expense;
        totalIncome += income;
      }

      // Update totals row
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A2:G2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [
            [
              'Totals',
              totalExpense,
              totalIncome,
              '',
              `Balance: ${totalIncome - totalExpense}`,
              '',
              '',
            ],
          ],
        },
      });

      // Get sheet ID for formatting
      const sheetResponse = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });

      const sheetId = await this.getSheetId(sheetResponse.data.sheets || [], sheetName);

      // Format the totals row
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId,
                  startRowIndex: 1,
                  endRowIndex: 2,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: {
                      red: 0.9,
                      green: 0.9,
                      blue: 0.9,
                    },
                    textFormat: {
                      bold: true,
                    },
                  },
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat)',
              },
            },
          ],
        },
      });
    } catch (error) {
      console.error('Error updating totals:', error);
      Sentry.captureException(error);
    }
  }

  private async getSheetId(sheets: any[], sheetName: string): Promise<number> {
    const sheet = sheets.find(
      (s: any) => s.properties?.title === sheetName
    );
    if (!sheet?.properties?.sheetId) {
      throw new Error(`Could not find sheet ID for sheet: ${sheetName}`);
    }
    return sheet.properties.sheetId;
  }

  private async checkAndCreateQuarterlyReport(currentDate: Date) {
    const month = currentDate.getMonth();
    const quarter = Math.floor(month / 3) + 1;
    const year = currentDate.getFullYear();
    const quarterEndMonth = quarter * 3;

    if (month === quarterEndMonth - 1) {
      // Create quarterly report
      const quarterName = `Q${quarter} ${year}`;
      const spreadsheetId = this.spreadsheetId;

      // Create new spreadsheet for quarterly report
      const newSpreadsheet = await this.sheets.spreadsheets.create({
        resource: {
          properties: {
            title: `Quarterly Report - ${quarterName}`,
          },
        },
      });

      // Copy data from monthly sheets
      const months = [
        this.getMonthName(quarterEndMonth - 2),
        this.getMonthName(quarterEndMonth - 1),
        this.getMonthName(quarterEndMonth),
      ];

      for (const month of months) {
        const sheetName = `${month} ${year}`;
        try {
          const response = await this.sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A:F`,
          });

          if (response.data.values) {
            await this.sheets.spreadsheets.values.append({
              spreadsheetId: newSpreadsheet.data.spreadsheetId,
              range: 'Sheet1!A:F',
              valueInputOption: 'USER_ENTERED',
              resource: { values: response.data.values },
            });
          }
        } catch (error) {
          console.error(`Error copying data from ${sheetName}:`, error);
        }
      }

      // Add quarterly totals
      await this.updateTotals(newSpreadsheet.data.spreadsheetId);
    }
  }

  private getMonthName(month: number): string {
    return new Date(2000, month, 1).toLocaleString('default', { month: 'long' });
  }
} 