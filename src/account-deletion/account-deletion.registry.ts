import { Injectable } from '@nestjs/common';
import { DELETION_RESOURCE_TYPES } from './account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionResourceType,
} from './account-deletion.types';

@Injectable()
export class AccountDeletionRegistry {
  private readonly executors = new Map<DeletionResourceType, AccountDeletionAdapter>();

  register(adapter: AccountDeletionAdapter): void {
    const seen = new Set<DeletionResourceType>();
    for (const resourceType of adapter.resourceTypes) {
      if (seen.has(resourceType) || this.executors.has(resourceType)) {
        throw new Error('deletion_executor_duplicate');
      }
      seen.add(resourceType);
    }
    for (const resourceType of seen) this.executors.set(resourceType, adapter);
  }

  getExecutor(resourceType: DeletionResourceType): AccountDeletionAdapter {
    const executor = this.executors.get(resourceType);
    if (!executor) throw new Error('deletion_executor_missing');
    return executor;
  }

  assertReady(): void {
    for (const resourceType of DELETION_RESOURCE_TYPES) {
      if (!this.executors.has(resourceType)) {
        throw new Error('deletion_registry_not_ready');
      }
    }
  }
}
