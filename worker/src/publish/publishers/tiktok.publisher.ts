// worker/src/publish/publishers/tiktok.publisher.ts
import axios from 'axios';
import { Publisher, PublishInput, PublishResult } from '../publisher.interface';
import { logger } from '../../logger';

interface TikTokCreds {
  accessToken: string;
  refreshToken: string;
  openId: string;
}

export const tiktokPublisher: Publisher = {
  async publish(input: PublishInput): Promise<PublishResult> {
    const creds = input.credentials as unknown as TikTokCreds;
    if (!creds.accessToken) throw new Error('tiktok credentials missing accessToken');

    // Step 1: Init upload via PULL_FROM_URL (TikTok pulls our public MinIO URL itself)
    const initResp = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
      {
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: input.videoUrl,
        },
        post_info: {
          title: (input.caption ?? '').slice(0, 150),
          privacy_level: 'SELF_ONLY',  // sandbox mode = posts only visible to creator
          disable_comment: false,
          disable_duet: false,
          disable_stitch: false,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
        validateStatus: () => true,
      },
    );
    if (initResp.status !== 200 || initResp.data?.error?.code !== 'ok') {
      throw new Error(`TikTok init failed: ${initResp.status} ${JSON.stringify(initResp.data).slice(0, 300)}`);
    }

    const publishId = initResp.data.data?.publish_id;
    if (!publishId) throw new Error(`TikTok init: no publish_id in response`);
    logger.info({ publishId }, 'TikTok publish initiated');

    // Step 2: Poll publish status until "PUBLISH_COMPLETE" or error
    let lastStatus = '';
    for (let i = 0; i < 30; i++) {  // up to 5 minutes
      await new Promise((r) => setTimeout(r, 10000));
      const statusResp = await axios.post(
        'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
        { publish_id: publishId },
        {
          headers: {
            Authorization: `Bearer ${creds.accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      lastStatus = statusResp.data?.data?.status ?? 'unknown';
      logger.debug({ publishId, status: lastStatus }, 'TikTok status poll');
      if (lastStatus === 'PUBLISH_COMPLETE') {
        const postId = statusResp.data?.data?.publicaly_available_post_id?.[0] ?? statusResp.data?.data?.publicly_available_post_id?.[0];
        return {
          externalUrl: postId ? `https://www.tiktok.com/@${creds.openId}/video/${postId}` : `https://www.tiktok.com/@${creds.openId}`,
          externalPostId: postId ?? publishId,
        };
      }
      if (lastStatus === 'FAILED' || lastStatus === 'PROCESSING_DOWNLOAD_FAILED') {
        const failReason = statusResp.data?.data?.fail_reason ?? lastStatus;
        throw new Error(`TikTok publish failed: ${failReason}`);
      }
    }
    throw new Error(`TikTok publish timeout after 5min, last status: ${lastStatus}`);
  },
};
