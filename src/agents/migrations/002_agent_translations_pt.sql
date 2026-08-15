-- Португальские имена и описания ассистентов.
--
-- Португальский добавляли позже остальных языков, и эту таблицу не досыпали:
-- все 16 ассистентов отдавали русские имена и описания, потому что запрос
-- деградирует в русские колонки при отсутствии перевода.
--
-- Имена — транслитерация в португальском написании, по образцу уже
-- существующих fr и es: там Андрей стал Andreï/Andréi, Герман — Guerman.
-- В португальском «Andrei» читается верно и без диакритики, а «Guerman»
-- нужен по той же причине, что во французском и испанском: без «u» сочетание
-- «ge» звучит как «же».
--
-- ON CONFLICT — чтобы повтор был безопасен: ключ составной
-- (entity_type, entity_id, locale).

INSERT INTO agent_translations (entity_type, entity_id, locale, display_name, description) VALUES
('agent', '1',  'pt', 'Micha',     'Coach certificado pelos padrões da ICF'),
('agent', '2',  'pt', 'Ólia',      'Psicóloga e facilitadora de autoconhecimento'),
('agent', '3',  'pt', 'Macha',     'Praticante de jogos transformacionais'),
('agent', '4',  'pt', 'Irina',     'Especialista de RH e orientadora de carreira'),
('agent', '5',  'pt', 'Liana',     'Numeróloga: ajuda a compreender-se a si e ao seu caminho através dos números e dos ciclos da vida'),
('agent', '6',  'pt', 'Ekaterina', 'Ajuda a escrever textos que se leem bem e que vendem'),
('agent', '7',  'pt', 'Andrei',    'Ajuda a resolver questões de negócio'),
('agent', '8',  'pt', 'Guerman',   'Sobre atenção plena'),
('agent', '9',  'pt', 'Anna',      'Contabilista: ajuda com contabilidade, impostos e finanças da empresa'),
('agent', '10', 'pt', 'Alexei',    'Advogado: ajuda a esclarecer questões jurídicas'),
('agent', '11', 'pt', 'Alexandra', 'Estratega de marketing com acesso a dados atuais do mercado.'),
('agent', '12', 'pt', 'Roman',     'Faço tudo aquilo que os outros não conseguem'),
('agent', '13', 'pt', 'Shankara',  'Astrólogo védico (Jyotish): ajuda a compreender o seu caminho através do mapa natal, das nakshatras, dos dashas e dos trânsitos planetários'),
('agent', '14', 'pt', 'Raya',      'Leitora de Human Design: ajuda a compreender o seu tipo, estratégia e autoridade através do seu bodygraph'),
('agent', '15', 'pt', 'Julia',     'Produtora de SMM: escrevo guiões para vídeos curtos com os outros assistentes da Linkeon, produzo-os e publico nas redes sociais.'),
('agent', '17', 'pt', 'Vitali',    'Diretor financeiro: ajuda com modelação financeira do negócio (fluxo de caixa, unit economics, escolha do regime fiscal) e com finanças pessoais (orçamento, fundo de emergência, poupança, alocação de investimentos).')
ON CONFLICT (entity_type, entity_id, locale) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description  = EXCLUDED.description,
      updated_at   = now();
