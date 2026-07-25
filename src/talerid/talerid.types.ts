export type TalerIdConnectionStatus = 'connected' | 'ambiguous' | 'error';

export interface TalerIdConnection {
  userId: string;
  taleridUserId: string;
  scopes: string;
  status: TalerIdConnectionStatus;
  accessExpiresAt?: Date;
}
