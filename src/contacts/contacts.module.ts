import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { Neo4jModule } from '../neo4j/neo4j.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { ContactsAccountDeletionAdapter } from './contacts-account-deletion.adapter';

@Module({
  imports: [CommonModule, Neo4jModule, AccountDeletionModule],
  controllers: [ContactsController],
  providers: [ContactsService, ContactsAccountDeletionAdapter],
  exports: [ContactsService],
})
export class ContactsModule {}
