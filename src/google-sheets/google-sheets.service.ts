import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';

@Injectable()
export class GoogleSheetsService {
  private auth: JWT;
  private sheets: any;

  constructor(private configService: ConfigService) {
    this.initializeGoogleAuth();
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

  async addEntry(entry: {
    amount: number;
    category: string;
    description: string;
    date: string;
    type: 'expense' | 'income';
  }) {
    const spreadsheetId = this.configService.get('SPREADSHEET_ID');
    const currentDate = new Date();
    const month = currentDate.toLocaleString('default', { month: 'long' });
    const year = currentDate.getFullYear();
    const sheetName = `${month} ${year}`;

    try {
      // Check if sheet exists, if not create it
      await this.ensureSheetExists(spreadsheetId, sheetName);

      // Add the entry
      const values = [
        [
          entry.date,
          entry.type,
          entry.category,
          entry.description,
          entry.amount,
        ],
      ];

      await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:E`,
        valueInputOption: 'USER_ENTERED',
        resource: { values },
      });

      // Update totals after adding entry
      await this.updateTotals(spreadsheetId, sheetName);

      // Check if we need to create a quarterly report
      await this.checkAndCreateQuarterlyReport(currentDate);
    } catch (error) {
      console.error('Error adding entry:', error);
      throw error;
    }
  }

  private async ensureSheetExists(spreadsheetId: string, sheetName: string) {
    try {
      await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A1`,
      });
    } catch (error) {
      // Sheet doesn't exist, create it
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
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

      // Add headers and totals row
      await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1:F2`,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [
            ['Date', 'Type', 'Category', 'Description', 'Amount', 'Running Total'],
            ['', '', '', '', '', '=SUM(E3:E)']
          ],
        },
      });

      // Format the totals row
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId: await this.getSheetId(spreadsheetId, sheetName),
                  startRowIndex: 1,
                  endRowIndex: 2,
                  startColumnIndex: 0,
                  endColumnIndex: 6,
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
    }
  }

  private async updateTotals(spreadsheetId: string, sheetName: string) {
    try {
      // Get all values from the sheet
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:E`,
      });

      const values = response.data.values || [];
      if (values.length <= 2) return; // Only headers and totals row

      // Calculate totals
      let totalExpense = 0;
      let totalIncome = 0;
      let runningTotal = 0;

      // Start from index 2 to skip headers and totals row
      for (let i = 2; i < values.length; i++) {
        const row = values[i];
        const amount = parseFloat(row[4]) || 0;
        const type = row[1];

        if (type === 'expense') {
          totalExpense += amount;
          runningTotal -= amount;
        } else if (type === 'income') {
          totalIncome += amount;
          runningTotal += amount;
        }
      }

      // Update totals row
      await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A2:F2`,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [
            [
              'Totals',
              '',
              '',
              '',
              `Income: ${totalIncome}\nExpense: ${totalExpense}\nBalance: ${runningTotal}`,
              `=SUM(E3:E)`
            ],
          ],
        },
      });

      // Add running total to each row
      const runningTotals: number[][] = [];
      let currentTotal = 0;

      for (let i = 2; i < values.length; i++) {
        const row = values[i];
        const amount = parseFloat(row[4]) || 0;
        const type = row[1];

        if (type === 'expense') {
          currentTotal -= amount;
        } else if (type === 'income') {
          currentTotal += amount;
        }

        runningTotals.push([currentTotal]);
      }

      // Update running totals
      if (runningTotals.length > 0) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!F3:F${values.length}`,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: runningTotals,
          },
        });
      }
    } catch (error) {
      console.error('Error updating totals:', error);
    }
  }

  private async getSheetId(spreadsheetId: string, sheetName: string): Promise<number> {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId,
    });
    const sheet = response.data.sheets.find(
      (s: any) => s.properties.title === sheetName
    );
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
      const spreadsheetId = this.configService.get('SPREADSHEET_ID');

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
      await this.updateTotals(newSpreadsheet.data.spreadsheetId, 'Sheet1');
    }
  }

  private getMonthName(month: number): string {
    return new Date(2000, month, 1).toLocaleString('default', { month: 'long' });
  }
} 