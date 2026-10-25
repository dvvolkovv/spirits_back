/**
 * Имя инструмента справки — отдельным модулем без импортов: его берут
 * products-cli-tool.ts (а через него chat.service и tg-router), и тянуть туда
 * статьи и константы списания незачем.
 */
export const LINKEON_HELP_TOOL_NAME = 'linkeon_help';
