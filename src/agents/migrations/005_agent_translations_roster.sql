-- 005_agent_translations_roster.sql
-- Переводы имён и описаний для изменённого состава ассистентов.
--
-- Три разных пробела, все три обнаружены после миграции 004:
--   1. Андрей (7) — переводы описывают СТАРУЮ роль «помогает решить запросы по
--      бизнесу». Русское описание уже про запуск бизнеса, а шесть локалей
--      продолжали отдавать прежнюю формулировку. Это хуже отсутствия перевода:
--      отсутствие деградирует в русский текст, а неверный перевод выглядит
--      достоверно и вводит в заблуждение.
--   2. Дмитрий (19) — переводов нет вообще, миграция 003 их не досыпала. С мая
--      нерусские пользователи видели русские имя и описание.
--   3. Павел (20) и Полина (21) — заведены в 004, переводов не было.
--
-- linkeon_voice (18) сознательно без переводов: служебная строка, на экран
-- выбора не попадает (SERVICE_AGENTS в agents.service.ts).
-- Герман (8) не трогаем: он скрыт, но его переводы верны и безвредны.
--
-- Транслитерация — по конвенции существующих строк: de даёт немецкое написание
-- (Mischa, Andrej, Witali), es и fr — с диакритикой, zh — иероглифы.
--
-- ON CONFLICT обязателен: для Андрея это UPDATE существующих шести строк,
-- для остальных INSERT. Повторный прогон безопасен.
--
-- Применяется вручную, как 001-004: автоматического раннера в
-- src/agents/migrations нет, а общий npm run migrate на проде застревает
-- на base/001.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/agents/migrations/005_agent_translations_roster.sql

INSERT INTO agent_translations (entity_type, entity_id, locale, display_name, description) VALUES

-- Андрей (7) — запуск бизнеса. Перезаписывает прежнего «бизнес-консультанта».
('agent', '7',  'en', 'Andrey',  'Business launch: legal form and tax regime, first processes, first hires, day-to-day operations at the start'),
('agent', '7',  'de', 'Andrej',  'Unternehmensgründung: Rechtsform und Steuerregime, erste Prozesse, erste Mitarbeiter, operatives Geschäft am Start'),
('agent', '7',  'es', 'Andréi',  'Lanzamiento de negocio: forma jurídica y régimen fiscal, primeros procesos, primeras contrataciones, operativa inicial'),
('agent', '7',  'fr', 'Andreï',  'Création d''entreprise : forme juridique et régime fiscal, premiers processus, premiers recrutements, opérationnel au démarrage'),
('agent', '7',  'pt', 'Andrei',  'Lançamento de negócio: forma jurídica e regime fiscal, primeiros processos, primeiras contratações, operação no arranque'),
('agent', '7',  'zh', '安德烈',   '创业启动：法律形式与税务模式、初期流程、首批招聘、起步阶段的日常运营'),

-- Дмитрий (19) — технический директор. Пробел с миграции 003.
('agent', '19', 'en', 'Dmitry',  'CTO: architecture, tech stack choice, development team, timelines and technical debt'),
('agent', '19', 'de', 'Dmitrij', 'Technischer Leiter (CTO): Architektur, Stack-Auswahl, Entwicklungsteam, Zeitschätzungen und technische Schulden'),
('agent', '19', 'es', 'Dmitri',  'Director técnico (CTO): arquitectura, elección del stack, equipo de desarrollo, plazos y deuda técnica'),
('agent', '19', 'fr', 'Dmitri',  'Directeur technique (CTO) : architecture, choix de la stack, équipe de développement, délais et dette technique'),
('agent', '19', 'pt', 'Dmitri',  'Diretor técnico (CTO): arquitetura, escolha da stack, equipa de desenvolvimento, prazos e dívida técnica'),
('agent', '19', 'zh', '德米特里', '技术总监（CTO）：架构、技术栈选型、研发团队、工期评估与技术债'),

-- Павел (20) — продажи.
('agent', '20', 'en', 'Pavel',   'Sales expert: funnel, scripts, negotiations, handling objections'),
('agent', '20', 'de', 'Pawel',   'Vertriebsexperte: Funnel, Gesprächsleitfäden, Verhandlungen, Umgang mit Einwänden'),
('agent', '20', 'es', 'Pável',   'Experto en ventas: embudo, guiones, negociación, manejo de objeciones'),
('agent', '20', 'fr', 'Pavel',   'Expert en vente : tunnel, scripts, négociation, traitement des objections'),
('agent', '20', 'pt', 'Pavel',   'Especialista em vendas: funil, guiões, negociação, tratamento de objeções'),
('agent', '20', 'zh', '帕维尔',   '销售专家：转化漏斗、话术、谈判、异议处理'),

-- Полина (21) — образ жизни. Формулировка намеренно не медицинская во всех
-- локалях: «coach», а не «врач» или «нутрициолог».
('agent', '21', 'en', 'Polina',  'Lifestyle coach: sleep, nutrition, movement, recovery and habits'),
('agent', '21', 'de', 'Polina',  'Lifestyle-Coach: Schlaf, Ernährung, Bewegung, Erholung und Gewohnheiten'),
('agent', '21', 'es', 'Polina',  'Coach de estilo de vida: sueño, alimentación, movimiento, recuperación y hábitos'),
('agent', '21', 'fr', 'Polina',  'Coach mode de vie : sommeil, alimentation, mouvement, récupération et habitudes'),
('agent', '21', 'pt', 'Polina',  'Coach de estilo de vida: sono, alimentação, movimento, recuperação e hábitos'),
('agent', '21', 'zh', '波琳娜',   '生活方式教练：睡眠、饮食、运动、恢复与习惯')

ON CONFLICT (entity_type, entity_id, locale) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description  = EXCLUDED.description,
      updated_at   = now();
