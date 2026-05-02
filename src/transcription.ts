import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface TranscriptionConfig {
  model: string;
  baseURL: string;
  enabled: boolean;
  fallbackMessage: string;
}

// Defaults to Groq (free tier, fast LPU inference, OpenAI-compatible API).
// Override with TRANSCRIPTION_BASE_URL / TRANSCRIPTION_MODEL in .env to point
// at OpenAI Whisper or another OpenAI-compatible provider.
const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'whisper-large-v3-turbo',
  baseURL: 'https://api.groq.com/openai/v1',
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
};

async function transcribeWithProvider(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const env = readEnvFile([
    'GROQ_API_KEY',
    'OPENAI_API_KEY',
    'TRANSCRIPTION_BASE_URL',
    'TRANSCRIPTION_MODEL',
  ]);
  const baseURL = env.TRANSCRIPTION_BASE_URL || config.baseURL;
  const model = env.TRANSCRIPTION_MODEL || config.model;
  // Pick the API key matching the base URL: Groq → GROQ_API_KEY,
  // anything else (incl. OpenAI) → OPENAI_API_KEY.
  const apiKey = baseURL.includes('groq.com')
    ? env.GROQ_API_KEY
    : env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn(
      { baseURL },
      'Transcription API key missing — set GROQ_API_KEY or OPENAI_API_KEY in .env',
    );
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const client = new OpenAI({ apiKey, baseURL });

    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    const transcription = await client.audio.transcriptions.create({
      file: file,
      model,
      response_format: 'text',
    });

    return transcription as unknown as string;
  } catch (err) {
    logger.error({ err, baseURL, model }, 'Transcription failed');
    return null;
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: logger as never,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    logger.debug({ bytes: buffer.length }, 'Downloaded audio message');

    const transcript = await transcribeWithProvider(buffer, config);

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
