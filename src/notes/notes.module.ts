import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { TalerIdModule } from '../talerid/talerid.module';
import { VoiceModule } from '../voice/voice.module';

/** Заметки: list/create + «Улучшить» (improve+update через VoiceImproveService) поверх TalerID. */
@Module({
  imports: [TalerIdModule, VoiceModule],
  controllers: [NotesController],
})
export class NotesModule {}
