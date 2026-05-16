// worker/src/publish/publishers/youtube.publisher.ts
import axios from 'axios';
import { google } from 'googleapis';
import { Readable } from 'stream';
import { Publisher, PublishInput, PublishResult } from '../publisher.interface';
import { logger } from '../../logger';

interface YouTubeCreds {
  accessToken: string;
  refreshToken: string;
  channelId?: string;
  /** Optional ISO timestamp of when access_token was issued — for proactive refresh. Not strictly required. */
  issuedAt?: string;
}

export const youtubePublisher: Publisher = {
  async publish(input: PublishInput): Promise<PublishResult> {
    const creds = input.credentials as unknown as YouTubeCreds;
    if (!creds.accessToken || !creds.refreshToken) {
      throw new Error('youtube credentials missing accessToken or refreshToken');
    }

    // Set up oauth2 client with proactive refresh handler
    const oauth2 = new google.auth.OAuth2(
      process.env.YOUTUBE_OAUTH_CLIENT_ID,
      process.env.YOUTUBE_OAUTH_CLIENT_SECRET,
    );
    oauth2.setCredentials({
      access_token: creds.accessToken,
      refresh_token: creds.refreshToken,
    });

    const youtube = google.youtube({ version: 'v3', auth: oauth2 });

    // Download the MP4 into a stream
    const mp4Resp = await axios.get(input.videoUrl, { responseType: 'stream', timeout: 60000 });
    const videoStream = mp4Resp.data as Readable;

    // Build title + description. Title must be ≤100 chars. Add #Shorts to ensure it's classified as a Short.
    const captionFirstLine = (input.caption ?? '').split('\n')[0].trim();
    const titleBase = captionFirstLine || 'Linkeon SMM';
    const title = `${titleBase.slice(0, 90)} #Shorts`;
    const description = `${input.caption ?? ''}\n\n#Shorts\nmy.linkeon.io`;

    const insertResp = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title,
          description,
          categoryId: '22',  // People & Blogs
          tags: ['linkeon', 'shorts'],
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        mimeType: 'video/mp4',
        body: videoStream,
      },
    });

    const videoId = insertResp.data.id;
    if (!videoId) throw new Error(`YouTube videos.insert returned no id`);
    const externalUrl = `https://www.youtube.com/shorts/${videoId}`;
    logger.info({ videoId, externalUrl }, 'YouTube publish ok');

    return {
      externalUrl,
      externalPostId: videoId,
    };
  },

  async delete(input) {
    const creds = input.credentials as unknown as YouTubeCreds;
    const oauth2 = new google.auth.OAuth2(
      process.env.YOUTUBE_OAUTH_CLIENT_ID,
      process.env.YOUTUBE_OAUTH_CLIENT_SECRET,
    );
    oauth2.setCredentials({
      access_token: creds.accessToken,
      refresh_token: creds.refreshToken,
    });
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });
    await youtube.videos.delete({ id: input.externalPostId });
  },
};
