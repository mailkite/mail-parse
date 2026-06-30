// Docs: docs/architecture/mime-parser-implementation.md
//
// Reference middleware (enrich phase): annotate a coarse language guess on text parts, by Unicode
// script. Heuristic (script ≠ language), but enough to demonstrate the enrich phase and the
// context→Message.annotations flow. A real version would use an n-gram model as a community plugin.

import { decodeCharset } from '../decode.js';
import type { Middleware } from '../middleware.js';

/** Coarse script→language guess. */
export function detectLanguage(text: string): string {
  if (/[぀-ヿ]/.test(text)) return 'ja'; // hiragana/katakana
  if (/[一-鿿]/.test(text)) return 'zh'; // Han (no kana)
  if (/[가-힯]/.test(text)) return 'ko'; // Hangul
  if (/[Ѐ-ӿ]/.test(text)) return 'ru'; // Cyrillic
  if (/[؀-ۿ]/.test(text)) return 'ar'; // Arabic
  if (/[Ͱ-Ͽ]/.test(text)) return 'el'; // Greek
  return 'en';
}

export function languageDetect(): Middleware {
  return {
    name: 'mailkite-middleware-language-detect',
    phase: 'enrich',
    match: { maintype: 'text' },
    async onPart(part, next) {
      // Prefer a channel a prior decode-phase middleware already produced; else decode the body.
      const text = part.text ?? part.html ?? decodeCharset(part.body, part.meta.charset).text;
      if (text.trim().length > 0) part.context['language'] = detectLanguage(text);
      await next();
    },
  };
}
