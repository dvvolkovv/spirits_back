import { panOffset } from './pan';
import type { ImageBox, Segment } from './types';

/** Кадров на переезд к следующему абзацу. */
export const MOVE = 15;
/** Пик приближения абзаца. */
export const ZOOM = 1.08;
/** Кадров на появление рамки после переезда. */
export const RING_FADE = 10;
/** Кадров до конца реплики, за которые приближение отпускается. */
export const RELEASE = 10;
/**
 * Отступ рамки от краёв снимка. На пике приближения край рамки уходит наружу;
 * чтобы он остался в кадре, нужно ≥ (W/2)·(1 − 1/ZOOM) = 40 px. Берём 60 — с запасом.
 */
export const RING_INSET = 60;

export interface AnswerMotion {
  /** Сдвиг высокого снимка по вертикали, пиксели кадра. */
  y: number;
  zoom: number;
  /** Непрозрачность рамки абзаца, 0–1. */
  ring: number;
  box: ImageBox;
}

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

/** Easing.inOut(Easing.cubic) из Remotion. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Кусочно-линейно по ключевым точкам с зажимом краёв — interpolate Remotion с clamp. */
export function lerpKeys(t: number, input: number[], output: number[]): number {
  if (t <= input[0]) return output[0];
  for (let i = 1; i < input.length; i++) {
    if (t <= input[i]) {
      const k = (t - input[i - 1]) / (input[i] - input[i - 1]);
      return output[i - 1] + (output[i] - output[i - 1]) * k;
    }
  }
  return output[output.length - 1];
}

/**
 * Где снимок, насколько он приближен и видна ли рамка на кадре сцены «Ответ».
 * segments — реплики сцены с кадрами от начала ролика; sceneFrom переводит их
 * в кадры сцены. null — показывать нечего.
 */
export function answerMotion(o: {
  frame: number;
  segments: Segment[];
  sceneFrom: number;
  boxes: ImageBox[];
  imageHeight: number;
  frameHeight: number;
  anchorY: number;
}): AnswerMotion | null {
  if (o.segments.length === 0 || o.boxes.length === 0) return null;
  let idx = 0;
  o.segments.forEach((s, i) => {
    if (s.from - o.sceneFrom <= o.frame) idx = i;
  });
  const boxOf = (s: Segment): ImageBox => o.boxes.find((b) => b.n === s.box) ?? o.boxes[0];
  const offsetOf = (s: Segment): number => {
    const b = boxOf(s);
    return panOffset({ boxTop: b.top, boxHeight: b.height, imageHeight: o.imageHeight, frameHeight: o.frameHeight, anchorY: o.anchorY });
  };

  const seg = o.segments[idx];
  const t = o.frame - (seg.from - o.sceneFrom);
  const prev = idx > 0 ? offsetOf(o.segments[idx - 1]) : 0;
  const target = offsetOf(seg);
  const y = prev + (target - prev) * easeInOutCubic(clamp01(t / MOVE));
  const hold = Math.max(MOVE + 1, seg.duration - RELEASE);
  const stop = Math.max(hold + 1, seg.duration);
  return {
    y,
    zoom: lerpKeys(t, [0, MOVE, hold, stop], [1, ZOOM, ZOOM, 1]),
    ring: lerpKeys(t, [MOVE, MOVE + RING_FADE], [0, 1]),
    box: boxOf(seg),
  };
}
