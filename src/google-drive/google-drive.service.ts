import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import * as Sentry from '@sentry/node';
import { Readable } from 'stream';

@Injectable()
export class GoogleDriveService {
  private auth: JWT;
  private drive: any;
  private readonly rootFolderId: string;

  constructor(private configService: ConfigService) {
    this.initializeGoogleAuth();
    const folderId = this.configService.get<string>('GOOGLE_DRIVE_FOLDER_ID');
    if (!folderId) {
      throw new Error('GOOGLE_DRIVE_FOLDER_ID is not defined');
    }
    this.rootFolderId = folderId;
  }

  private async initializeGoogleAuth() {
    try {
      const clientEmail = this.configService.get('GOOGLE_CLIENT_EMAIL');
      const privateKey = this.configService.get('GOOGLE_PRIVATE_KEY');

      if (!clientEmail || !privateKey) {
        console.error('Missing Google credentials:', {
          hasClientEmail: !!clientEmail,
          hasPrivateKey: !!privateKey,
        });
        throw new Error('Missing Google credentials');
      }

      this.auth = new JWT({
        email: clientEmail,
        key: privateKey,
        scopes: [
          'https://www.googleapis.com/auth/drive',
        ],
      });

      this.drive = google.drive({ version: 'v3', auth: this.auth });
      console.log('Successfully initialized Google Drive client');
    } catch (error) {
      console.error('Failed to initialize Google Drive client:', error);
      throw error;
    }
  }

  private async ensureMonthFolderExists(): Promise<string> {
    try {
      const date = new Date();
      const month = date.toLocaleString('default', { month: 'long' });
      const year = date.getFullYear();
      const folderName = `${month} ${year}`;

      console.log('Checking for month folder:', folderName);
      
      // Check if folder exists in the root folder
      const response = await this.drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${this.rootFolderId}' in parents and trashed=false`,
        fields: 'files(id, name)',
      });

      if (response.data.files.length > 0) {
        console.log('Found existing month folder:', response.data.files[0].id);
        return response.data.files[0].id;
      }

      console.log('Creating new month folder:', folderName);
      // Create folder if it doesn't exist
      const folder = await this.drive.files.create({
        requestBody: {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [this.rootFolderId],
        },
        fields: 'id',
      });

      console.log('Created new month folder:', folder.data.id);
      return folder.data.id;
    } catch (error) {
      console.error('Folder operation error:', error);
      Sentry.captureException(error);
      throw new Error('Failed to create or find month folder in Google Drive');
    }
  }

  async uploadImage(imageUrl: string, fileName: string): Promise<string> {
    try {
      console.log('Starting image upload process:', {
        imageUrl,
        fileName,
        rootFolderId: this.rootFolderId,
      });

      // Ensure the month folder exists
      const monthFolderId = await this.ensureMonthFolderExists();

      // Download the image
      console.log('Downloading image from URL...');
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
      }
      const imageBuffer = await response.arrayBuffer();
      console.log('Successfully downloaded image');

      // Create a readable stream from the buffer
      const stream = new Readable();
      stream.push(Buffer.from(imageBuffer));
      stream.push(null);

      // Upload the image to Google Drive
      console.log('Uploading image to Google Drive...');
      const file = await this.drive.files.create({
        requestBody: {
          name: fileName,
          parents: [monthFolderId],
          mimeType: 'image/jpeg',
        },
        media: {
          mimeType: 'image/jpeg',
          body: stream,
        },
        fields: 'id, webViewLink',
      });
      console.log('Successfully uploaded file:', file.data.id);

      // Make the file publicly accessible
      console.log('Setting file permissions...');
      await this.drive.permissions.create({
        fileId: file.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
      });
      console.log('Successfully set file permissions');

      return file.data.webViewLink;
    } catch (error) {
      console.error('Image upload error:', error);
      Sentry.captureException(error, {
        extra: { imageUrl, fileName },
      });
      throw new Error('Failed to upload image to Google Drive');
    }
  }
} 