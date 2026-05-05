import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { Neo4jModule } from '../neo4j/neo4j.module';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

@Module({
  imports: [CommonModule, Neo4jModule],
  controllers: [ContactsController],
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactsModule {}
