import 'reflect-metadata';
import { AdminModule } from '../admin/admin.module';
import { RetentionModule } from './retention.module';
import { RetentionUnsubscribeController } from './retention-unsubscribe.controller';
import { RetentionService } from './retention.service';

describe('RetentionModule wiring', () => {
  it('регистрирует публичный контроллер и экспортирует сервис', () => {
    expect(Reflect.getMetadata('controllers', RetentionModule)).toContain(RetentionUnsubscribeController);
    expect(Reflect.getMetadata('exports', RetentionModule)).toContain(RetentionService);
  });

  it('AdminModule импортирует RetentionModule', () => {
    expect(Reflect.getMetadata('imports', AdminModule)).toContain(RetentionModule);
  });
});
