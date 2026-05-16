// worker/src/publish/publisher.interface.ts
export type Platform = 'telegram' | 'vk' | 'youtube' | 'tiktok' | 'instagram';

export interface PublishInput {
  platform: Platform;
  /** Decrypted credentials JSON (shape depends on platform). */
  credentials: Record<string, unknown>;
  /** Public MP4 URL (already in MinIO bucket). */
  videoUrl: string;
  /** Caption text, optional. May contain emojis + URL. */
  caption: string | null;
  /** Display name of the social account — for logging. */
  accountDisplayName: string;
}

export interface PublishResult {
  /** Public URL of the published post (https://t.me/c/.../123 or similar). */
  externalUrl: string;
  /** Platform-internal post id (used for later delete). */
  externalPostId: string;
}

export interface Publisher {
  publish(input: PublishInput): Promise<PublishResult>;
  /**
   * Best-effort delete of a previously-published post.
   * Optional — may throw "not supported" on some platforms.
   */
  delete?(input: { credentials: Record<string, unknown>; externalPostId: string }): Promise<void>;
}
