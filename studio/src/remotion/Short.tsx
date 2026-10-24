import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import type { ShortProps } from '../types';
import { Captions } from './Caption';
import { Answer } from './scenes/Answer';
import { Final } from './scenes/Final';
import { Hook } from './scenes/Hook';
import { Question } from './scenes/Question';

export const Short: React.FC<ShortProps> = (p) => {
  const { scenes, segments } = p.timeline;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Sequence from={scenes.hook.from} durationInFrames={scenes.hook.duration}>
        <Hook hook={p.hook} questionShot={p.questionShot} />
      </Sequence>
      <Sequence from={scenes.question.from} durationInFrames={scenes.question.duration}>
        <Question questionShot={p.questionShot} durationInFrames={scenes.question.duration} />
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
      <Sequence from={scenes.final.from} durationInFrames={scenes.final.duration}>
        <Final assistantsCount={p.final.assistantsCount} disclaimer={p.final.disclaimer} />
      </Sequence>
      {/* Зацепку и финал дублирует крупный текст сцены — субтитры только у вопроса и ответа. */}
      <Captions segments={segments.filter((s) => s.scene === 'question' || s.scene === 'answer')} />
      {segments.map((s) => (
        // У каждой реплики своя длина: отыгравший звук размонтируется (урок веб-плеера мультфильма).
        <Sequence key={s.lineId} from={s.from} durationInFrames={s.duration}>
          <Audio src={staticFile(s.audio)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
