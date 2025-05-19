export default () => ({
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
  },
  google: {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY,
    spreadsheetId: process.env.SPREADSHEET_ID,
    driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
  },
}); 