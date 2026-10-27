import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { msToFrames, SKIT_HOOK_MS } from '../timeline';
import type { SkitShortProps } from '../types';
import { Captions, CueCaptions } from './Caption';
import { Answer } from './scenes/Answer';
import { Clip } from './scenes/Clip';
import { Final } from './scenes/Final';
import { Question } from './scenes/Question';

/**
 * Ролик со сценками: конфликт (Omni) → вопрос → настоящий ответ → развязка
 * (Omni) → финал. Зацепка — надпись поверх первых секунд конфликта.
 */
export const SkitShort: React.FC<SkitShortProps> = (p) => {
  const { scenes, segments } = p.timeline;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Sequence from={scenes.conflict.from} durationInFrames={scenes.conflict.duration}>
        <Clip video={p.clips.conflict.video} hook={p.hook} hookFrames={msToFrames(SKIT_HOOK_MS, p.fps)} />
      </Sequence>
      <Sequence from={scenes.question.from} durationInFrames={scenes.question.duration}>
        <Question questionShot={p.questionShot} durationInFrames={scenes.question.duration} badge={p.badge} />
      </Sequence>
      <Sequence from={scenes.answer.from} durationInFrames={scenes.answer.duration}>
        <Answer
          answerShot={p.answerShot}
          imageHeight={p.answerShotHeight}
          boxes={p.boxes}
          segments={segments.filter((s) => s.scene === 'answer')}
          sceneFrom={scenes.answer.from}
        />
      </Sequence>
      <Sequence from={scenes.punchline.from} durationInFrames={scenes.punchline.duration}>
        <Clip video={p.clips.punchline.video} />
      </Sequence>
      <Sequence from={scenes.final.from} durationInFrames={scenes.final.duration}>
        <Final assistantsCount={p.final.assistantsCount} disclaimer={p.final.disclaimer} />
      </Sequence>
      {/* Финал дублирует крупный текст сцены — у озвученных реплик субтитры только у вопроса и ответа. */}
      <Captions segments={segments.filter((s) => s.scene === 'question' || s.scene === 'answer')} />
      {/* Реплики сценок — всегда с субтитрами: большинство смотрит без звука. */}
      <CueCaptions cues={[...p.clips.conflict.cues, ...p.clips.punchline.cues]} />
      {segments.map((s) => (
        // У каждой реплики своя длина: отыгравший звук размонтируется (урок веб-плеера мультфильма).
        <Sequence key={s.lineId} from={s.from} durationInFrames={s.duration}>
          <Audio src={staticFile(s.audio)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
