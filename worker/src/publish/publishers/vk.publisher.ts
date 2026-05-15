// worker/src/publish/publishers/vk.publisher.ts
import axios from 'axios';
import FormData from 'form-data';
import { Publisher, PublishInput, PublishResult } from '../publisher.interface';
import { logger } from '../../logger';

const VK_API_VERSION = '5.199';

interface VkCreds {
  accessToken: string;
  userId: number;
  /** Optional group id (negative number, e.g. -1234567 for community walls). If absent, publishes to user's wall. */
  groupId?: number;
}

export const vkPublisher: Publisher = {
  async publish(input: PublishInput): Promise<PublishResult> {
    const creds = input.credentials as unknown as VkCreds;
    if (!creds.accessToken) throw new Error('vk credentials missing accessToken');

    // Step 1: video.save — get an upload URL
    const saveParams = new URLSearchParams({
      access_token: creds.accessToken,
      v: VK_API_VERSION,
      name: input.caption?.slice(0, 100) ?? 'SMM Linkeon',
      description: input.caption?.slice(0, 500) ?? '',
    });
    if (creds.groupId) saveParams.set('group_id', String(Math.abs(creds.groupId)));
    const saveResp = await axios.post('https://api.vk.com/method/video.save', saveParams.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000, validateStatus: () => true,
    });
    if (saveResp.status !== 200 || !saveResp.data?.response?.upload_url) {
      throw new Error(`VK video.save failed: ${saveResp.status} ${JSON.stringify(saveResp.data).slice(0, 200)}`);
    }
    const uploadUrl = saveResp.data.response.upload_url;
    const ownerIdAfterSave = saveResp.data.response.owner_id as number;
    const videoIdAfterSave = saveResp.data.response.video_id as number;

    // Step 2: Download MP4 from MinIO, then POST multipart to VK upload URL
    const mp4 = await axios.get<ArrayBuffer>(input.videoUrl, { responseType: 'arraybuffer', timeout: 60000 });
    const form = new FormData();
    form.append('video_file', Buffer.from(mp4.data), { filename: 'video.mp4', contentType: 'video/mp4' });
    const uploadResp = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity, maxBodyLength: Infinity,
      timeout: 300000, validateStatus: () => true,
    });
    if (uploadResp.status !== 200) {
      throw new Error(`VK video upload failed: ${uploadResp.status} ${JSON.stringify(uploadResp.data).slice(0, 200)}`);
    }
    logger.info({ ownerId: ownerIdAfterSave, videoId: videoIdAfterSave }, 'VK video uploaded');

    // Step 3: wall.post with video attachment
    const wallParams = new URLSearchParams({
      access_token: creds.accessToken,
      v: VK_API_VERSION,
      attachments: `video${ownerIdAfterSave}_${videoIdAfterSave}`,
      message: input.caption ?? '',
    });
    if (creds.groupId) wallParams.set('owner_id', `-${Math.abs(creds.groupId)}`);
    else wallParams.set('owner_id', String(creds.userId));
    wallParams.set('from_group', creds.groupId ? '1' : '0');

    const postResp = await axios.post('https://api.vk.com/method/wall.post', wallParams.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000, validateStatus: () => true,
    });
    if (postResp.status !== 200 || !postResp.data?.response?.post_id) {
      throw new Error(`VK wall.post failed: ${postResp.status} ${JSON.stringify(postResp.data).slice(0, 200)}`);
    }
    const postId = postResp.data.response.post_id as number;
    const ownerForUrl = creds.groupId ? `-${Math.abs(creds.groupId)}` : String(creds.userId);
    const externalUrl = `https://vk.com/wall${ownerForUrl}_${postId}`;
    logger.info({ externalUrl }, 'VK wall.post ok');

    return {
      externalUrl,
      externalPostId: `${ownerForUrl}_${postId}`,
    };
  },

  async delete(input) {
    const creds = input.credentials as unknown as VkCreds;
    const [ownerId, postId] = input.externalPostId.split('_');
    if (!ownerId || !postId) return;
    await axios.post('https://api.vk.com/method/wall.delete', new URLSearchParams({
      access_token: creds.accessToken,
      v: VK_API_VERSION,
      owner_id: ownerId,
      post_id: postId,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
      validateStatus: () => true,
    });
  },
};
