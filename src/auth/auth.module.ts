import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailService } from './email.service';
import { OAuthGoogleService } from './oauth-google.service';
import { IdentityModule } from '../identity/identity.module';

@Module({
  imports: [IdentityModule],
  controllers: [AuthController],
  providers: [AuthService, EmailService, OAuthGoogleService],
})
export class AuthModule {}
