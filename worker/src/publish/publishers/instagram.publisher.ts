// worker/src/publish/publishers/instagram.publisher.ts
import axios from 'axios';
import { Publisher, PublishInput, PublishResult } from '../publisher.interface';
import { logger } from '../../logger';

interface InstagramCreds {
  accessToken: string;     // page-level long-lived token
  igUserId: string;
  pageId: string;
}

export const instagramPublisher: Publisher = {
  async publish(input: PublishInput): Promise<PublishResult> {
    const creds = input.credentials as unknown as InstagramCreds;
    if (!creds.accessToken || !creds.igUserId) {
      throw new Error('instagram credentials missing accessToken or igUserId');
    }

    // Step 1: Create Reels container
    const createResp = await axios.post(
      `https://graph.facebook.com/v18.0/${creds.igUserId}/media`,
      null,
      {
        params: {
          media_type: 'REELS',
          video_url: input.videoUrl,
          caption: input.caption ?? '',
          access_token: creds.accessToken,
        },
        timeout: 30000,
        validateStatus: () => true,
      },
    );
    if (createResp.status !== 200 || !createResp.data?.id) {
      throw new Error(`IG create container failed: ${createResp.status} ${JSON.stringify(createResp.data).slice(0, 300)}`);
    }
    const containerId = createResp.data.id;
    logger.info({ containerId }, 'IG container created');

    // Step 2: Poll container status until FINISHED or ERROR
    let lastStatus = '';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      const statusResp = await axios.get(`https://graph.facebook.com/v18.0/${containerId}`, {
        params: { fields: 'status_code', access_token: creds.accessToken },
        timeout: 10000,
        validateStatus: () => true,
      });
      lastStatus = statusResp.data?.status_code ?? 'unknown';
      logger.debug({ containerId, status: lastStatus }, 'IG status poll');
      if (lastStatus === 'FINISHED') break;
      if (lastStatus === 'ERROR' || lastStatus === 'EXPIRED') {
        throw new Error(`IG container ${lastStatus}`);
      }
    }
    if (lastStatus !== 'FINISHED') {
      throw new Error(`IG container timeout, last status: ${lastStatus}`);
    }

    // Step 3: Publish the container
    const publishResp = await axios.post(
      `https://graph.facebook.com/v18.0/${creds.igUserId}/media_publish`,
      null,
      {
        params: { creation_id: containerId, access_token: creds.accessToken },
        timeout: 30000,
        validateStatus: () => true,
      },
    );
    if (publishResp.status !== 200 || !publishResp.data?.id) {
      throw new Error(`IG media_publish failed: ${publishResp.status} ${JSON.stringify(publishResp.data).slice(0, 300)}`);
    }
    const mediaId = publishResp.data.id;
    const externalUrl = `https://www.instagram.com/reel/${mediaId}/`;
    logger.info({ mediaId, externalUrl }, 'IG publish ok');

    return {
      externalUrl,
      externalPostId: mediaId,
    };
  },

  async delete(input) {
    const creds = input.credentials as unknown as InstagramCreds;
    await axios.delete(`https://graph.facebook.com/v18.0/${input.externalPostId}`, {
      params: { access_token: creds.accessToken },
      timeout: 15000,
      validateStatus: () => true,
    });
  },
};
