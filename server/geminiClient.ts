import { GoogleGenAI } from '@google/genai';

let cachedClient: GoogleGenAI | null = null;

export function hasGeminiKey(): boolean {
  const k = process.env.GEMINI_API_KEY;
  return Boolean(k && k.trim().length > 10 && !k.includes('MY_GEMINI_API_KEY'));
}

export function getGeminiClient(): GoogleGenAI | null {
  if (!hasGeminiKey()) return null;
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        timeout: 45000,
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
