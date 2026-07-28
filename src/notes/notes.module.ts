import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { TalerIdModule } from '../talerid/talerid.module';

/** Панель заметок [da5290c7]: read-only `GET /webhook/notes` поверх TalerIdNotesConnector (mcp:notes). */
@Module({
  imports: [TalerIdModule],
  controllers: [NotesController],
})
export class NotesModule {}
