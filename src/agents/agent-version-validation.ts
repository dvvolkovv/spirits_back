import { BadRequestException } from '@nestjs/common';

export function normalizeAgentVersionFields(
  descriptionValue: unknown,
  systemPromptValue: unknown,
): { description: string; systemPrompt: string } {
  const description = typeof descriptionValue === 'string'
    ? descriptionValue.trim()
    : '';
  const systemPrompt = typeof systemPromptValue === 'string'
    ? systemPromptValue.trim()
    : '';
  if (!systemPrompt) {
    throw new BadRequestException('system_prompt must not be empty');
  }
  if (systemPrompt.length > 200000) {
    throw new BadRequestException('system_prompt must not exceed 200000 characters');
  }
  if (description.length > 5000) {
    throw new BadRequestException('description must not exceed 5000 characters');
  }
  return { description, systemPrompt };
}
