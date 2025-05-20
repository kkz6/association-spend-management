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
  addedBy?: string;
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

interface MaintenanceCollection {
  flatNumber: string;
  ownerName: string;
  amount: number;
  status: 'Paid' | 'Pending';
  paymentDate?: string;
  markedBy?: string;
  description?: string;
}

interface CollectionSheet {
  type: 'maintenance' | 'water' | 'other';
  month: string;
  year: number;
  description?: string;
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
      
      // Format amount with INR symbol
      const formattedAmount = `₹${entry.amount.toLocaleString('en-IN')}`;
      
      // Ensure we have exactly 8 columns matching our header structure
      const values = [
        [
          entry.date,                                    // A: Date
          entry.type,                                    // B: Type
          entry.category,                                // C: Category
          entry.description,                             // D: Description
          formattedAmount,                               // E: Amount
          entry.receiptUrl || '',                        // F: Receipt URL
          entry.addedBy || 'Unknown',                    // G: Added By
          new Date().toISOString(),                      // H: Timestamp
        ],
      ];

      console.log('Values to be added:', values);

      // First, get the current data to find the next row
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheet}!A:H`,
      });

      const currentData = response.data.values || [];
      const nextRow = currentData.length + 1;

      // Update the specific row instead of appending
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheet}!A${nextRow}:H${nextRow}`,
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
      }

      // Always set up headers and totals row, regardless of whether sheet existed
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1:H2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [
            [
              'Date',      // A
              'Type',      // B
              'Category',  // C
              'Description', // D
              'Amount',    // E
              'Receipt',   // F
              'Added By',  // G
              'Timestamp', // H
            ],
            [
              'Totals',
              '',
              '',
              '',
              '=SUM(E3:E)',
              '',
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
        range: `${sheetName}!A:H`,
      });

      const values = response.data.values || [];
      if (values.length <= 2) return; // Only headers and totals row

      // Calculate totals
      let totalExpenses = 0;
      let totalIncome = 0;

      // Start from index 2 to skip headers and totals row
      for (let i = 2; i < values.length; i++) {
        const row = values[i];
        // Extract numeric value from amount string (remove ₹ and commas)
        const amountStr = row[4]?.replace(/[₹,]/g, '') || '0';
        const amount = parseFloat(amountStr);
        
        // Add to appropriate total based on type
        if (row[1]?.toLowerCase() === 'expense') {
          totalExpenses += amount;
        } else if (row[1]?.toLowerCase() === 'income') {
          totalIncome += amount;
        }
      }

      // Calculate net balance
      const netBalance = totalIncome - totalExpenses;

      // Update totals row
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A2:H2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [
            [
              'Totals',
              '',
              '',
              `Net Balance: ${netBalance >= 0 ? '+' : ''}₹${netBalance.toLocaleString('en-IN')}`,
              `Income: ₹${totalIncome.toLocaleString('en-IN')}\nExpenses: ₹${totalExpenses.toLocaleString('en-IN')}`,
              '',
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

  async getSheetData(sheetName: string): Promise<any[][]> {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A:H`,
      });

      return response.data.values || [];
    } catch (error) {
      console.error('Error getting sheet data:', error);
      Sentry.captureException(error);
      throw new Error('Failed to get sheet data');
    }
  }

  async initializeFlatInfoSheet(): Promise<void> {
    try {
      // Check if sheet exists
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });

      const sheetExists = response.data.sheets?.some(
        sheet => sheet.properties?.title === 'Flat Information'
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
                    title: 'Flat Information',
                    gridProperties: {
                      rowCount: 1000,
                      columnCount: 9
                    }
                  }
                }
              }
            ]
          }
        });

        // Add headers
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: "'Flat Information'!A1:I1",
          valueInputOption: 'RAW',
          requestBody: {
            values: [[
              'Flat Number',
              'Floor Number',
              'Owner Name',
              'Tenant Name',
              'Maintenance Amount',
              'Phone Number',
              'Email',
              'Is Occupied',
              'Last Updated'
            ]]
          }
        });
      }
    } catch (error) {
      console.error('Error initializing flat info sheet:', error);
      throw new Error('Failed to initialize flat information sheet');
    }
  }

  async updateFlatInfo(flatInfo: FlatInfo): Promise<void> {
    try {
      // First, ensure the sheet exists
      await this.initializeFlatInfoSheet();

      // Get all existing flats
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: "'Flat Information'!A:I", // Updated range to match our columns
      });

      const values = response.data.values || [];
      const headers = values[0] || [];
      const existingFlats = values.slice(1);

      // Find if flat already exists
      const flatIndex = existingFlats.findIndex(flat => flat[0] === flatInfo.flatNumber);

      const rowData = [
        flatInfo.flatNumber,
        flatInfo.floorNumber,
        flatInfo.ownerName,
        flatInfo.tenantName || '',
        flatInfo.maintenanceAmount.toString(),
        flatInfo.phoneNumber,
        flatInfo.email || '',
        flatInfo.isOccupied ? 'Yes' : 'No',
        flatInfo.lastUpdated
      ];

      if (flatIndex === -1) {
        // Add new flat
        await this.sheets.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: "'Flat Information'!A:I", // Updated range to match our columns
          valueInputOption: 'RAW',
          requestBody: {
            values: [rowData]
          }
        });
      } else {
        // Update existing flat
        const range = `'Flat Information'!A${flatIndex + 2}:I${flatIndex + 2}`; // +2 because of 0-based index and header row
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range,
          valueInputOption: 'RAW',
          requestBody: {
            values: [rowData]
          }
        });
      }
    } catch (error) {
      console.error('Error updating flat info:', error);
      throw new Error('Failed to update flat information');
    }
  }

  async getFlatInfo(flatNumber: string): Promise<FlatInfo | null> {
    try {
      const sheetName = 'Flat Information';
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A:I`,
      });

      const data = response.data.values || [];
      const flatRow = data.find(row => row[0] === flatNumber);

      if (!flatRow) return null;

      return {
        flatNumber: flatRow[0],
        floorNumber: flatRow[1],
        ownerName: flatRow[2],
        tenantName: flatRow[3] || undefined,
        maintenanceAmount: parseFloat(flatRow[4]),
        phoneNumber: flatRow[5],
        email: flatRow[6] || undefined,
        isOccupied: flatRow[7] === 'Yes',
        lastUpdated: flatRow[8]
      };
    } catch (error) {
      console.error('Error getting flat info:', error);
      Sentry.captureException(error);
      throw new Error('Failed to get flat information');
    }
  }

  async getAllFlats(): Promise<FlatInfo[]> {
    try {
      const sheetName = 'Flat Information';
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A:I`,  // Changed from A:J to A:I to match our columns
      });

      const data = response.data.values || [];
      // Skip header row
      return data.slice(1).map(row => ({
        flatNumber: row[0],
        floorNumber: row[1],
        ownerName: row[2],
        tenantName: row[3] || undefined,
        maintenanceAmount: parseFloat(row[4]),
        phoneNumber: row[5],
        email: row[6] || undefined,
        isOccupied: row[7] === 'Yes',
        lastUpdated: row[8]
      }));
    } catch (error) {
      console.error('Error getting all flats:', error);
      Sentry.captureException(error);
      throw new Error('Failed to get flat information');
    }
  }

  private async getOrCreateCollectionSheet(collectionType: CollectionSheet): Promise<string> {
    try {
      let sheetName: string;
      if (collectionType.type === 'maintenance') {
        const quarter = Math.floor(new Date().getMonth() / 3) + 1;
        sheetName = `Q${quarter} ${collectionType.year}`;
      } else {
        sheetName = `${collectionType.type} ${collectionType.month} ${collectionType.year}`;
      }

      // Get the collection spreadsheet ID from environment
      const collectionSheetId = this.configService.get<string>('MAINTENANCE_SPREADSHEET_ID');
      if (!collectionSheetId) {
        throw new Error('MAINTENANCE_SPREADSHEET_ID is not defined in environment variables');
      }

      // Check if sheet exists in the collection spreadsheet
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: collectionSheetId,
      });

      const sheetExists = response.data.sheets?.some(
        (sheet) => sheet.properties?.title === sheetName,
      );

      if (!sheetExists) {
        console.log('Creating new collection sheet:', sheetName);
        // Create new sheet
        const createResponse = await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: collectionSheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: sheetName,
                    gridProperties: {
                      rowCount: 1000,
                      columnCount: 6
                    }
                  }
                }
              }
            ]
          }
        });

        // Get the new sheet ID from the response
        const newSheetId = createResponse.data.replies[0].addSheet.properties.sheetId;

        // Add headers
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: collectionSheetId,
          range: `${sheetName}!A1:F1`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [[
              'Flat Number',
              'Owner Name',
              'Amount',
              'Status',
              'Payment Date',
              'Added By'
            ]]
          }
        });

        // Format headers using the new sheet ID
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: collectionSheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId: newSheetId,
                    startRowIndex: 0,
                    endRowIndex: 1,
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

        console.log('Successfully created collection sheet:', sheetName);
      }

      return sheetName;
    } catch (error) {
      console.error('Error getting or creating collection sheet:', error);
      Sentry.captureException(error);
      throw new Error('Failed to get or create collection sheet');
    }
  }

  async initializeCollection(collectionType: CollectionSheet, amount: number): Promise<void> {
    try {
      console.log('Initializing collection:', collectionType);
      const sheetName = await this.getOrCreateCollectionSheet(collectionType);
      const flats = await this.getAllFlats();
      const collectionSheetId = this.configService.get<string>('MAINTENANCE_SPREADSHEET_ID');
      
      if (!collectionSheetId) {
        throw new Error('MAINTENANCE_SPREADSHEET_ID is not defined in environment variables');
      }

      // Get existing entries
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: collectionSheetId,
        range: `${sheetName}!A:F`,
      });

      const existingEntries = response.data.values || [];
      const existingFlats = new Set(existingEntries.slice(1).map(row => row[0]));

      // Add new entries for flats not yet in the sheet
      const newEntries = flats
        .filter(flat => !existingFlats.has(flat.flatNumber))
        .map(flat => [
          flat.flatNumber,
          flat.ownerName,
          amount.toString(),
          'Pending',
          '',
          ''
        ]);

      if (newEntries.length > 0) {
        console.log('Adding new entries to collection sheet:', newEntries.length);
        await this.sheets.spreadsheets.values.append({
          spreadsheetId: collectionSheetId,
          range: `${sheetName}!A:F`,
          valueInputOption: 'RAW',
          requestBody: {
            values: newEntries
          }
        });
        console.log('Successfully added new entries to collection sheet');
      } else {
        console.log('No new entries to add to collection sheet');
      }
    } catch (error) {
      console.error('Error initializing collection:', error);
      Sentry.captureException(error);
      throw new Error('Failed to initialize collection');
    }
  }

  async updateCollectionStatus(
    collectionType: CollectionSheet,
    flatNumber: string,
    status: 'Paid' | 'Pending',
    addedBy: string
  ): Promise<void> {
    try {
      const sheetName = await this.getOrCreateCollectionSheet(collectionType);
      const collectionSheetId = this.configService.get<string>('MAINTENANCE_SPREADSHEET_ID');
      
      if (!collectionSheetId) {
        throw new Error('MAINTENANCE_SPREADSHEET_ID is not defined in environment variables');
      }

      // Get all entries
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: collectionSheetId,
        range: `${sheetName}!A:F`,
      });

      const entries = response.data.values || [];
      const flatIndex = entries.findIndex((row, index) => index > 0 && row[0] === flatNumber);

      if (flatIndex === -1) {
        throw new Error('Flat not found in collection');
      }

      // Update status
      const rowData = [
        entries[flatIndex][0], // Flat Number
        entries[flatIndex][1], // Owner Name
        entries[flatIndex][2], // Amount
        status,
        status === 'Paid' ? new Date().toISOString().split('T')[0] : '',
        addedBy
      ];

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: collectionSheetId,
        range: `${sheetName}!A${flatIndex + 1}:F${flatIndex + 1}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [rowData]
        }
      });
    } catch (error) {
      console.error('Error updating collection status:', error);
      Sentry.captureException(error);
      throw new Error('Failed to update collection status');
    }
  }

  async getCollection(collectionType: CollectionSheet): Promise<MaintenanceCollection[]> {
    try {
      const sheetName = await this.getOrCreateCollectionSheet(collectionType);
      const collectionSheetId = this.configService.get<string>('MAINTENANCE_SPREADSHEET_ID');
      
      if (!collectionSheetId) {
        throw new Error('MAINTENANCE_SPREADSHEET_ID is not defined in environment variables');
      }

      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: collectionSheetId,
        range: `${sheetName}!A:F`,
      });

      const data = response.data.values || [];
      return data.slice(1).map(row => ({
        flatNumber: row[0],
        ownerName: row[1],
        amount: parseFloat(row[2]),
        status: row[3] as 'Pending' | 'Paid',
        paymentDate: row[4] || undefined,
        markedBy: row[5] || undefined,
        description: row[6] || undefined
      }));
    } catch (error) {
      console.error('Error getting collection:', error);
      Sentry.captureException(error);
      throw new Error('Failed to get collection');
    }
  }

  async getAllCollections(): Promise<CollectionSheet[]> {
    try {
      const spreadsheetId = this.configService.get<string>('MAINTENANCE_SPREADSHEET_ID');
      if (!spreadsheetId) {
        throw new Error('MAINTENANCE_SPREADSHEET_ID is not defined');
      }

      const sheets = await this.sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties'
      });

      const collections: CollectionSheet[] = [];
      for (const sheet of sheets.data.sheets || []) {
        const title = sheet.properties?.title || '';
        // Match patterns like "Maintenance Q1 2024", "Water March 2024", or custom names
        const maintenanceMatch = title.match(/Maintenance Q([1-4]) (\d{4})/);
        const waterMatch = title.match(/Water (\w+) (\d{4})/);
        const otherMatch = title.match(/(.+?) (\w+) (\d{4})/);

        if (maintenanceMatch) {
          collections.push({
            type: 'maintenance',
            month: `Q${maintenanceMatch[1]}`,
            year: parseInt(maintenanceMatch[2])
          });
        } else if (waterMatch) {
          collections.push({
            type: 'water',
            month: waterMatch[1],
            year: parseInt(waterMatch[2])
          });
        } else if (otherMatch) {
          collections.push({
            type: 'other',
            description: otherMatch[1],
            month: otherMatch[2],
            year: parseInt(otherMatch[3])
          });
        }
      }

      return collections;
    } catch (error) {
      console.error('Error getting all collections:', error);
      throw new Error('Failed to retrieve collections');
    }
  }
} 