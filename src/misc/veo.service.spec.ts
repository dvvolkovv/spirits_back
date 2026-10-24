/**
 * Видео-провайдер на Gemini Omni Flash.
 *
 * 22.10.2026 Google закрыл превью Veo 3.1 (veo-3.1-generate-preview,
 * veo-3.1-fast-generate-preview): predictLongRunning стал отвечать 404 «no
 * longer available», и каждый ролик падал на старте. GA-версий Veo по ключу
 * Gemini API нет, официальная замена — gemini-omni-1.1-flash через Interactions
 * API. Формы запросов и ответов ниже сняты с живых вызовов 24.10.2026.
 */

jest.mock('axios');

import axios from 'axios';
import { VeoService, OMNI_MODEL } from './veo.service';

const mockedPost = axios.post as jest.Mock;
const mockedGet = axios.get as jest.Mock;

function axiosError(status: number, data: any) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

function makeService() {
  process.env.GOOGLE_AI_API_KEY = 'test-key';
  return new VeoService();
}

beforeEach(() => {
  mockedPost.mockReset();
  mockedGet.mockReset();
});

describe('VeoService.startGenerate', () => {
  it('ставит фоновую генерацию Omni и возвращает id взаимодействия', async () => {
    mockedPost.mockResolvedValue({ data: { id: 'v1_base', status: 'in_progress' } });
    const id = await makeService().startGenerate({
      prompt: 'Она говорит: «Привет»', durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p',
    });

    expect(id).toBe('v1_base');
    const [url, body, cfg] = mockedPost.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(body).toEqual({
      model: OMNI_MODEL,
      background: true,
      input: 'Она говорит: «Привет»',
      response_format: { type: 'video', aspect_ratio: '9:16', resolution: '1080p', duration: '8s' },
    });
    expect(cfg.headers['x-goog-api-key']).toBe('test-key');
  });

  it('фото идут частями input перед текстом, несколько фото — как образ персонажа', async () => {
    mockedPost.mockResolvedValue({ data: { id: 'v1_ref', status: 'in_progress' } });
    await makeService().startGenerate({
      prompt: 'говорящая голова',
      referenceImagesB64: [
        { b64: 'AAA', mime: 'image/jpeg' },
        { b64: 'BBB', mime: 'image/png' },
        { b64: 'CCC', mime: '' },
      ],
    });

    const body = mockedPost.mock.calls[0][1];
    expect(body.input).toEqual([
      { type: 'image', data: 'AAA', mime_type: 'image/jpeg' },
      { type: 'image', data: 'BBB', mime_type: 'image/png' },
      { type: 'image', data: 'CCC', mime_type: 'image/jpeg' },
      { type: 'text', text: 'говорящая голова' },
    ]);
    // Без явной задачи два фото Omni может принять за первый и последний кадр.
    expect(body.generation_config).toEqual({ video_config: { task: 'reference_to_video' } });
  });

  it('одно фото оставляет выбор режима модели', async () => {
    mockedPost.mockResolvedValue({ data: { id: 'v1_one', status: 'in_progress' } });
    await makeService().startGenerate({ prompt: 'портрет', referenceImagesB64: [{ b64: 'AAA', mime: 'image/jpeg' }] });

    const body = mockedPost.mock.calls[0][1];
    expect(body.input).toHaveLength(2);
    expect(body.generation_config).toBeUndefined();
  });

  it('по умолчанию 16:9, 720p и 8 секунд', async () => {
    mockedPost.mockResolvedValue({ data: { id: 'v1_def', status: 'in_progress' } });
    await makeService().startGenerate({ prompt: 'кот' });

    expect(mockedPost.mock.calls[0][1].response_format)
      .toEqual({ type: 'video', aspect_ratio: '16:9', resolution: '720p', duration: '8s' });
  });

  it('негативный промпт дописывается в текст: отдельного поля у Omni нет', async () => {
    mockedPost.mockResolvedValue({ data: { id: 'v1_neg', status: 'in_progress' } });
    await makeService().startGenerate({ prompt: 'кот на окне', negativePrompt: 'надписи, водяные знаки' });

    const body = mockedPost.mock.calls[0][1];
    expect(body.input).toBe('кот на окне\n\nAvoid: надписи, водяные знаки');
    expect(JSON.stringify(body)).not.toMatch(/negative/i);
  });

  it('ответ без id — ошибка, а не пустая задача', async () => {
    mockedPost.mockResolvedValue({ data: { status: 'in_progress' } });
    await expect(makeService().startGenerate({ prompt: 'кот' })).rejects.toThrow(/no interaction id/);
  });

  it('снятая модель отдаёт причину Google в тексте ошибки', async () => {
    mockedPost.mockRejectedValue(axiosError(404, {
      error: { message: 'This model models/x is no longer available.', code: 'not_found' },
    }));
    await expect(makeService().startGenerate({ prompt: 'кот' }))
      .rejects.toThrow('Omni generate failed: This model models/x is no longer available.');
  });

  it('исчерпанная квота — понятный текст про лимит, без сырого биллинга', async () => {
    mockedPost.mockRejectedValue(axiosError(429, {
      error: { message: 'You exceeded your current quota, please check your plan.', code: 'resource_exhausted' },
    }));
    await expect(makeService().startGenerate({ prompt: 'кот' })).rejects.toThrow(/дневной лимит генераций видео/);
  });
});

describe('VeoService.startExtend', () => {
  it('продлевает предыдущий шаг по previous_interaction_id', async () => {
    mockedPost.mockResolvedValue({ data: { id: 'v1_ext', status: 'in_progress' } });
    const id = await makeService().startExtend({
      prompt: 'продолжение', previousInteractionId: 'v1_base', aspectRatio: '16:9', resolution: '720p',
    });

    expect(id).toBe('v1_ext');
    expect(mockedPost.mock.calls[0][1]).toEqual({
      model: OMNI_MODEL,
      background: true,
      previous_interaction_id: 'v1_base',
      input: 'продолжение',
      response_format: { type: 'video', aspect_ratio: '16:9', resolution: '720p', duration: '7s' },
    });
  });
});

describe('VeoService.getOperation', () => {
  const mp4 = Buffer.from('fake-mp4-bytes');

  it('in_progress — ещё не готово', async () => {
    mockedGet.mockResolvedValue({ data: { id: 'v1_x', status: 'in_progress' } });
    const st = await makeService().getOperation('v1_x');

    expect(st).toEqual({ done: false, video: null, error: null });
    expect(mockedGet.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/interactions/v1_x');
  });

  it('completed — ролик из инлайн-данных шага model_output', async () => {
    mockedGet.mockResolvedValue({ data: {
      id: 'v1_x', status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'кот' }] },
        { type: 'thought', signature: 'sig' },
        { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: mp4.toString('base64') }] },
      ],
    } });
    const st = await makeService().getOperation('v1_x');

    expect(st.done).toBe(true);
    expect(st.error).toBeNull();
    expect(st.video?.equals(mp4)).toBe(true);
  });

  it('completed со ссылкой вместо данных — скачивает по ссылке с ключом', async () => {
    mockedGet
      .mockResolvedValueOnce({ data: {
        id: 'v1_x', status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri: 'https://g/files/abc:download?alt=media' }] }],
      } })
      .mockResolvedValueOnce({ data: mp4 });
    const st = await makeService().getOperation('v1_x');

    expect(st.video?.equals(mp4)).toBe(true);
    expect(mockedGet.mock.calls[1][0]).toBe('https://g/files/abc:download?alt=media');
    expect(mockedGet.mock.calls[1][1].headers['x-goog-api-key']).toBe('test-key');
  });

  it('completed без видео — ошибка с объяснением модели', async () => {
    mockedGet.mockResolvedValue({ data: {
      id: 'v1_x', status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot create videos of real public figures.' }] }],
    } });
    const st = await makeService().getOperation('v1_x');

    expect(st.done).toBe(true);
    expect(st.video).toBeNull();
    expect(st.error).toContain('I cannot create videos of real public figures.');
  });

  it('failed — текст ошибки Google из массива errors', async () => {
    mockedGet.mockResolvedValue({ data: {
      id: 'v1_x', status: 'failed', errors: [{ message: 'Internal error encountered. Please retry.', code: 'INTERNAL' }],
    } });
    const st = await makeService().getOperation('v1_x');

    expect(st).toEqual({ done: true, video: null, error: 'Internal error encountered. Please retry.' });
  });

  it('отказ фильтра (INVALID_ARGUMENT) — с подсказкой, что переформулировать', async () => {
    // Живой ответ на промпт со знаменитостью, 24.10.2026.
    mockedGet.mockResolvedValue({ data: {
      id: 'v1_x', status: 'failed',
      errors: [{
        message: 'There was a problem processing your request. You will only be charged for tokens successfully generated.',
        code: 'INVALID_ARGUMENT',
      }],
    } });
    const st = await makeService().getOperation('v1_x');

    expect(st.done).toBe(true);
    expect(st.error).toMatch(/фильтр контента/);
    expect(st.error).toContain('There was a problem processing your request.');
  });

  it('failed с одиночным error тоже читается', async () => {
    mockedGet.mockResolvedValue({ data: { id: 'v1_x', status: 'failed', error: { message: 'Backend error' } } });
    const st = await makeService().getOperation('v1_x');

    expect(st.error).toBe('Backend error');
  });

  it('неожиданный статус не висит до таймаута', async () => {
    mockedGet.mockResolvedValue({ data: { id: 'v1_x', status: 'requires_action' } });
    const st = await makeService().getOperation('v1_x');

    expect(st.done).toBe(true);
    expect(st.error).toMatch(/requires_action/);
  });
});
