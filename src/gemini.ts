import { localTodayKey } from './i18n';
import type {
  Category,
  CurrencyCode,
  Locale,
  ParseSubscriptionResult,
  PaymentMethod,
} from './types';

export const MAX_CAPTURE_FILE_BYTES = 8 * 1024 * 1024;
export const CAPTURE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/heic,image/heif,image/gif,application/pdf,.pdf';

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'application/pdf',
]);

const COMPRESSIBLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const EXTENSION_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
};

export interface PreparedAttachment {
  data: string;
  mimeType: string;
  name: string;
  size: number;
  previewUrl: string | null;
}

function resolveMimeType(file: File): string {
  const direct = file.type.trim().toLowerCase();
  if (direct) {
    return direct === 'image/jpg' ? 'image/jpeg' : direct;
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TO_MIME[ext] ?? '';
}

async function blobToBase64(blob: Blob): Promise<string> {
  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(''));
  } catch {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('file_read_failed'));
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reject(new Error('file_read_failed'));
          return;
        }
        const comma = reader.result.indexOf(',');
        resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result);
      };
      reader.readAsDataURL(blob);
    });
  }
}

async function compressLargeImage(file: File): Promise<{ blob: Blob; mimeType: string }> {
  const tempUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image_decode_failed'));
      el.src = tempUrl;
    });

    const maxEdge = 1400;
    const largest = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const scale = largest > maxEdge ? maxEdge / largest : 1;
    const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { blob: file, mimeType: resolveMimeType(file) };

    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((out) => resolve(out), 'image/jpeg', 0.82),
    );

    if (blob && blob.size < file.size) {
      return { blob, mimeType: 'image/jpeg' };
    }
    return { blob: file, mimeType: resolveMimeType(file) };
  } catch {
    return { blob: file, mimeType: resolveMimeType(file) };
  } finally {
    URL.revokeObjectURL(tempUrl);
  }
}

export async function prepareReceiptAttachment(file: File): Promise<PreparedAttachment> {
  const resolvedMime = resolveMimeType(file);
  if (!ALLOWED_MIME_TYPES.has(resolvedMime)) {
    throw new Error('unsupported_file_type');
  }
  if (file.size > MAX_CAPTURE_FILE_BYTES) {
    throw new Error('file_too_large');
  }

  let uploadBlob: Blob = file;
  let uploadMime = resolvedMime;

  if (COMPRESSIBLE_IMAGE_TYPES.has(resolvedMime) && file.size > 600_000) {
    const compressed = await compressLargeImage(file);
    uploadBlob = compressed.blob;
    uploadMime = compressed.mimeType;
  }

  const data = await blobToBase64(uploadBlob);
  const previewUrl = uploadMime === 'application/pdf' ? null : URL.createObjectURL(uploadBlob);

  return {
    data,
    mimeType: uploadMime,
    name: file.name || (uploadMime === 'application/pdf' ? 'receipt.pdf' : 'receipt.jpg'),
    size: uploadBlob.size,
    previewUrl,
  };
}

async function extractInvokeError(error: unknown): Promise<Error> {
  console.error('[Renewly AI Capture]', error);

  const errObj =
    error && typeof error === 'object'
      ? (error as { name?: unknown; message?: unknown; context?: unknown })
      : undefined;

  if (
    errObj?.name === 'FunctionsFetchError' ||
    (typeof errObj?.message === 'string' &&
      errObj.message.includes('Failed to send a request to the Edge Function'))
  ) {
    return new Error('edge_network_error');
  }

  if (errObj?.name === 'FunctionsRelayError') {
    return new Error('edge_relay_error');
  }

  const context = errObj?.context;
  if (context && typeof context === 'object') {
    const resp = context as { status?: unknown; clone?: () => Response; json?: () => Promise<unknown> };
    try {
      const target = typeof resp.clone === 'function' ? resp.clone() : resp;
      if (typeof target.json === 'function') {
        const payload = (await target.json()) as {
          error?: unknown;
          code?: unknown;
          message?: unknown;
          msg?: unknown;
        } | null;
        if (payload && typeof payload === 'object') {
          for (const candidate of [payload.error, payload.code, payload.message, payload.msg]) {
            if (typeof candidate === 'string' && candidate.trim()) {
              return new Error(candidate.trim());
            }
          }
        }
      }
    } catch {
      // fall through to HTTP status mapping
    }

    const status = typeof resp.status === 'number' ? resp.status : 0;
    if (status === 401) return new Error('unauthorized');
    if (status === 403) return new Error('account_restricted');
    if (status === 413) return new Error('file_too_large');
    if (status === 429) return new Error('rate_limit_exceeded');
    if (status === 504) return new Error('edge_timeout');
    if (status >= 500) return new Error('gemini_upstream_error');
  }

  if (error instanceof Error) return error;
  if (typeof errObj?.message === 'string' && errObj.message.trim()) {
    return new Error(errObj.message.trim());
  }
  return new Error('gemini_upstream_error');
}

export async function parseSubscriptionWithGemini(params: {
  text: string;
  attachment: PreparedAttachment | null;
  locale: Locale;
  baseCurrency: CurrencyCode;
  categories: Category[];
  paymentMethods: PaymentMethod[];
}): Promise<ParseSubscriptionResult> {
  const { supabase } = await import('./supabase');
  if (!supabase) {
    throw new Error('gemini_upstream_error');
  }

  const body = {
    text: params.text.trim(),
    file: params.attachment
      ? {
          data: params.attachment.data,
          mimeType: params.attachment.mimeType,
          name: params.attachment.name,
        }
      : null,
    locale: params.locale,
    baseCurrency: params.baseCurrency,
    today: localTodayKey(),
    categories: params.categories.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      name_en: c.name_en,
    })),
    paymentMethods: params.paymentMethods.map((p) => ({
      id: p.id,
      name: p.name,
      name_en: p.name_en,
      type: p.type,
      last4: p.last4,
    })),
  };

  const { data, error } = await supabase.functions.invoke('parse-subscription', { body });
  if (error) {
    throw await extractInvokeError(error);
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(String(data.error));
  }

  const payload = (data ?? {}) as Partial<ParseSubscriptionResult>;
  return {
    model: typeof payload.model === 'string' ? payload.model : 'gemini-4-hydrogen',
    found: Boolean(payload.found),
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    items: Array.isArray(payload.items) ? payload.items : [],
  };
}
