import { createClient } from 'jsr:@supabase/supabase-js@2';
import { GoogleGenAI } from 'npm:@google/genai@3.6.1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const ALLOWED_MODELS = new Set([
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-4-hydrogen',
  'gemini-4-argon',
  'gemini-4-carbon',
]);
const MAX_TEXT_CHARS = 8000;
const MAX_BASE64_CHARS = 11_500_000;

const SUPPORTED_CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP'] as const;
const SUPPORTED_INTERVALS = ['week', 'month', 'quarter', 'year', 'custom'] as const;
const BRAND_COLORS = [
  '#5B5BF0',
  '#7C3AED',
  '#E50914',
  '#1DB954',
  '#3B82F6',
  '#10A37F',
  '#F59E0B',
  '#EC4899',
  '#FF6A00',
  '#0F172A',
] as const;
const BRAND_ICONS = [
  'sparkles',
  'tv',
  'music',
  'cloud',
  'play_circle',
  'briefcase',
  'code',
  'layers',
  'shopping_bag',
  'heart',
  'credit_card',
  'globe',
] as const;

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
]);
const DOCUMENT_MIME_TYPES = new Set(['application/pdf']);

type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];
type BillingInterval = (typeof SUPPORTED_INTERVALS)[number];
type Confidence = 'high' | 'medium' | 'low';

interface RequestCategory {
  id: string;
  key?: string;
  name: string;
  name_en?: string;
}

interface RequestPaymentMethod {
  id: string;
  name: string;
  name_en?: string;
  type?: string;
  last4?: string | null;
}

interface ParseRequestBody {
  model?: string;
  text?: string;
  file?: {
    data?: string;
    mimeType?: string;
    name?: string;
  } | null;
  locale?: 'zh-CN' | 'en';
  baseCurrency?: CurrencyCode;
  today?: string;
  categories?: RequestCategory[];
  paymentMethods?: RequestPaymentMethod[];
}

interface ParsedItemOutput {
  name: string;
  amount: number;
  currency: CurrencyCode;
  interval: BillingInterval;
  interval_count: number;
  start_date: string;
  is_trial: boolean;
  trial_end_date: string | null;
  auto_renew: boolean;
  category_id: string | null;
  payment_method_id: string | null;
  color: string;
  icon: string;
  url: string;
  cancel_url: string;
  note: string;
  confidence: Confidence;
}

const PARSED_SUBSCRIPTION_SCHEMA = {
  type: 'object',
  properties: {
    found: {
      type: 'boolean',
      description: 'True if at least one subscription, membership, trial, or recurring bill was found.',
    },
    summary: {
      type: 'string',
      description: 'Short one-sentence summary in the requested user locale describing what was extracted or why nothing matched.',
    },
    items: {
      type: 'array',
      maxItems: 10,
      description: 'Extracted recurring subscriptions or trials.',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Clean service or membership name (e.g. Netflix, iCloud+, ChatGPT Plus).',
          },
          amount: {
            type: 'number',
            description: 'Billing amount per cycle (>= 0). Use 0 if only a free trial amount is listed with no price.',
          },
          currency: {
            type: 'string',
            enum: [...SUPPORTED_CURRENCIES],
            description: 'ISO currency code among CNY, USD, EUR, HKD, JPY, GBP.',
          },
          interval: {
            type: 'string',
            enum: [...SUPPORTED_INTERVALS],
            description: 'Billing cycle unit: week, month, quarter, year, or custom (days).',
          },
          interval_count: {
            type: 'integer',
            description: 'Number of interval units per cycle (1 for standard monthly/yearly, or number of days when interval is custom).',
          },
          start_date: {
            type: 'string',
            description: 'Billing date, purchase date, or anchor date in YYYY-MM-DD format.',
          },
          is_trial: {
            type: 'boolean',
            description: 'True if the receipt or text describes an active free trial before paid renewal.',
          },
          trial_end_date: {
            type: 'string',
            description: 'Trial expiration date in YYYY-MM-DD format if is_trial is true, otherwise empty string.',
          },
          auto_renew: {
            type: 'boolean',
            description: 'True unless text explicitly says auto-renew is turned off or cancelled.',
          },
          category_id: {
            type: 'string',
            description: 'Exact matching ID from the provided user categories list, or empty string if uncertain.',
          },
          payment_method_id: {
            type: 'string',
            description: 'Exact matching ID from the provided user payment methods list, or empty string if uncertain.',
          },
          color: {
            type: 'string',
            enum: [...BRAND_COLORS],
            description: 'Best matching hex color from Renewly palette.',
          },
          icon: {
            type: 'string',
            enum: [...BRAND_ICONS],
            description: 'Best matching icon key from Renewly icon set.',
          },
          url: {
            type: 'string',
            description: 'Official service website URL if known/confident (https://...), otherwise empty string.',
          },
          cancel_url: {
            type: 'string',
            description: 'Subscription management or cancellation URL if clearly shown in input, otherwise empty string.',
          },
          note: {
            type: 'string',
            description: 'Helpful concise note in the user locale (e.g. plan tier, order ID, card hint, or original currency if converted/unlisted).',
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Extraction confidence based on clarity of price, cycle, and service name.',
          },
        },
        required: [
          'name',
          'amount',
          'currency',
          'interval',
          'interval_count',
          'start_date',
          'is_trial',
          'trial_end_date',
          'auto_renew',
          'category_id',
          'payment_method_id',
          'color',
          'icon',
          'url',
          'cancel_url',
          'note',
          'confidence',
        ],
      },
    },
  },
  required: ['found', 'summary', 'items'],
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);

  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!token || !supabaseUrl || !anonKey) return reply({ error: 'unauthorized' }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) return reply({ error: 'unauthorized' }, 401);

  const { data: profile, error: profileError } = await userClient
    .from('profiles')
    .select('account_status,suspension_expires_at')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError) return reply({ error: 'server_misconfigured' }, 500);
  if (!isEffectiveActive(profile)) return reply({ error: 'account_restricted' }, 403);

  const geminiApiKey = Deno.env.get('GEMINI_API_KEY')?.trim();
  if (!geminiApiKey) return reply({ error: 'gemini_not_configured' }, 503);

  let body: ParseRequestBody;
  try {
    body = await request.json();
  } catch {
    return reply({ error: 'invalid_json' }, 400);
  }

  const locale: 'zh-CN' | 'en' = body.locale === 'en' ? 'en' : 'zh-CN';
  const baseCurrency: CurrencyCode = isCurrency(body.baseCurrency) ? body.baseCurrency : 'CNY';
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  const envModel = Deno.env.get('GEMINI_MODEL')?.trim() ?? '';
  const selectedModel = ALLOWED_MODELS.has(requestedModel)
    ? requestedModel
    : ALLOWED_MODELS.has(envModel)
      ? envModel
      : DEFAULT_MODEL;
  const today = isDateKey(body.today) ? body.today : shanghaiTodayKey();
  const rawText = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT_CHARS) : '';

  const file = body.file && typeof body.file === 'object' ? body.file : null;
  let cleanBase64 = '';
  let mimeType = '';
  let fileName = '';

  if (file && (file.data || file.mimeType)) {
    mimeType = typeof file.mimeType === 'string' ? file.mimeType.trim().toLowerCase() : '';
    if (!IMAGE_MIME_TYPES.has(mimeType) && !DOCUMENT_MIME_TYPES.has(mimeType)) {
      return reply({ error: 'unsupported_file_type' }, 400);
    }
    const rawData = typeof file.data === 'string' ? file.data.trim() : '';
    cleanBase64 = rawData.replace(/^data:[^;]+;base64,/i, '');
    if (!cleanBase64) return reply({ error: 'input_required' }, 400);
    if (cleanBase64.length > MAX_BASE64_CHARS) return reply({ error: 'file_too_large' }, 413);
    fileName = typeof file.name === 'string' ? file.name.trim().slice(0, 120) : '';
  }

  if (!rawText && !cleanBase64) {
    return reply({ error: 'input_required' }, 400);
  }

  const categories = Array.isArray(body.categories)
    ? body.categories
        .filter((c): c is RequestCategory => Boolean(c && typeof c.id === 'string' && typeof c.name === 'string'))
        .slice(0, 50)
    : [];
  const paymentMethods = Array.isArray(body.paymentMethods)
    ? body.paymentMethods
        .filter((p): p is RequestPaymentMethod => Boolean(p && typeof p.id === 'string' && typeof p.name === 'string'))
        .slice(0, 50)
    : [];

  const categoryIds = new Set(categories.map((c) => c.id));
  const paymentMethodIds = new Set(paymentMethods.map((p) => p.id));

  const systemInstruction = [
    'You are an accurate subscription billing parser for Renewly, a personal subscription tracker.',
    'Extract recurring subscriptions, memberships, cloud plans, SaaS plans, or free trials from the user text and/or attached receipt image or PDF.',
    'Rules:',
    `- Target user locale: ${locale}. Write "summary" and "note" in ${locale === 'en' ? 'English' : 'Simplified Chinese (简体中文)'}.`,
    `- Today's date: ${today}. Default fallback currency: ${baseCurrency}.`,
    `- Supported currencies: ${SUPPORTED_CURRENCIES.join(', ')}. If the receipt uses an unsupported currency, set currency to ${baseCurrency} and state the original currency and amount in "note".`,
    '- Renewly calculates next renewal dates automatically from start_date + interval + interval_count. Set start_date to the charge/order/billing date (or upcoming renewal date if only that is shown) in YYYY-MM-DD.',
    '- If a free trial is detected, set is_trial=true and trial_end_date to YYYY-MM-DD; otherwise set is_trial=false and trial_end_date="".',
    '- For category_id and payment_method_id, ONLY return an exact ID from the supplied context lists when confident, otherwise return "".',
    '- Choose color strictly from the allowed Renewly hex palette and icon strictly from the allowed icon enum.',
    '- Never invent subscriptions that are not supported by the input. If the input is unrelated or unreadable, return found=false and items=[].',
  ].join('\n');

  const contextLines = [
    `Today: ${today}`,
    `User locale: ${locale}`,
    `User base currency: ${baseCurrency}`,
    `Available categories: ${JSON.stringify(categories.map((c) => ({ id: c.id, key: c.key ?? '', name: c.name, name_en: c.name_en ?? '' })))}`,
    `Available payment methods: ${JSON.stringify(paymentMethods.map((p) => ({ id: p.id, name: p.name, name_en: p.name_en ?? '', type: p.type ?? '', last4: p.last4 ?? null })))}`,
    fileName ? `Attached file name: ${fileName}` : '',
    rawText ? `User input text:\n${rawText}` : 'User attached a receipt file with no additional text.',
  ].filter(Boolean);

  const inputBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mime_type: string }
    | { type: 'document'; data: string; mime_type: string }
  > = [{ type: 'text', text: contextLines.join('\n') }];

  if (cleanBase64) {
    if (DOCUMENT_MIME_TYPES.has(mimeType)) {
      inputBlocks.push({ type: 'document', data: cleanBase64, mime_type: 'application/pdf' });
    } else {
      inputBlocks.push({ type: 'image', data: cleanBase64, mime_type: mimeType });
    }
  }

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey, apiVersion: 'v1beta' });
    const interaction = await ai.interactions.create({
      model: selectedModel,
      store: false,
      system_instruction: systemInstruction,
      input: inputBlocks,
      generation_config: {
        thinking_level: 'low',
        max_output_tokens: 8192,
      },
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: PARSED_SUBSCRIPTION_SCHEMA,
      },
    });

    const rawOutput = extractOutputText(interaction);
    if (!rawOutput) {
      return reply({ error: 'gemini_parse_failed' }, 502);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripCodeFences(rawOutput));
    } catch {
      return reply({ error: 'gemini_parse_failed' }, 502);
    }

    const record = parsedJson && typeof parsedJson === 'object' ? (parsedJson as Record<string, unknown>) : {};
    const rawItems = Array.isArray(record.items) ? record.items : [];
    const items = rawItems
      .slice(0, 10)
      .map((entry) => sanitizeItem(entry, { baseCurrency, today, categoryIds, paymentMethodIds }))
      .filter((entry): entry is ParsedItemOutput => entry !== null);

    const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, 240) : '';
    const found = Boolean(record.found) && items.length > 0;

    return reply({
      ok: true,
      model: selectedModel,
      found,
      summary,
      items,
    });
  } catch (cause) {
    const status = extractUpstreamStatus(cause);
    console.error('parse-subscription failed', {
      model: selectedModel,
      status,
      message: cause instanceof Error ? cause.message.slice(0, 400) : 'unknown_error',
    });
    if (status === 402) {
      return reply({ error: 'gemini_billing_required', model: selectedModel }, 402);
    }
    if (status === 401 || status === 403) {
      return reply({ error: 'gemini_invalid_key' }, 502);
    }
    if (status === 429) {
      return reply({ error: 'rate_limit_exceeded' }, 429);
    }
    return reply({ error: 'gemini_upstream_error' }, 502);
  }
});

function isEffectiveActive(
  profile: { account_status?: string | null; suspension_expires_at?: string | null } | null,
): boolean {
  if (!profile) return true;
  if (profile.account_status === 'active') return true;
  if (
    profile.account_status === 'suspended' &&
    profile.suspension_expires_at &&
    Date.parse(profile.suspension_expires_at) <= Date.now()
  ) {
    return true;
  }
  return false;
}

function isCurrency(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

function isInterval(value: unknown): value is BillingInterval {
  return typeof value === 'string' && (SUPPORTED_INTERVALS as readonly string[]).includes(value);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const parsed = Date.parse(`${value.trim()}T00:00:00.000Z`);
  return Number.isFinite(parsed);
}

function shanghaiTodayKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function sanitizeHttpUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return url.toString().slice(0, 300);
    }
    return '';
  } catch {
    return '';
  }
}

function sanitizeItem(
  raw: unknown,
  ctx: {
    baseCurrency: CurrencyCode;
    today: string;
    categoryIds: Set<string>;
    paymentMethodIds: Set<string>;
  },
): ParsedItemOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, 80) : '';
  if (!name) return null;

  const numAmount = Number(obj.amount);
  const amount = Number.isFinite(numAmount) && numAmount >= 0 ? Math.round(numAmount * 100) / 100 : 0;

  const currencyRaw = typeof obj.currency === 'string' ? obj.currency.trim().toUpperCase() : '';
  const currency: CurrencyCode = isCurrency(currencyRaw) ? currencyRaw : ctx.baseCurrency;

  const intervalRaw = typeof obj.interval === 'string' ? obj.interval.trim().toLowerCase() : '';
  const interval: BillingInterval = isInterval(intervalRaw) ? intervalRaw : 'month';

  const countRaw = Math.round(Number(obj.interval_count) || 1);
  const interval_count = Math.max(1, Math.min(365, countRaw));

  const start_date = isDateKey(obj.start_date) ? obj.start_date.trim() : ctx.today;
  const is_trial = Boolean(obj.is_trial);
  const trial_end_date = is_trial
    ? (isDateKey(obj.trial_end_date) ? obj.trial_end_date.trim() : start_date)
    : null;
  const auto_renew = obj.auto_renew === undefined ? true : Boolean(obj.auto_renew);

  const rawCategoryId = typeof obj.category_id === 'string' ? obj.category_id.trim() : '';
  const category_id = rawCategoryId && ctx.categoryIds.has(rawCategoryId) ? rawCategoryId : null;

  const rawPmId = typeof obj.payment_method_id === 'string' ? obj.payment_method_id.trim() : '';
  const payment_method_id = rawPmId && ctx.paymentMethodIds.has(rawPmId) ? rawPmId : null;

  const rawColor = typeof obj.color === 'string' ? obj.color.trim().toUpperCase() : '';
  const color = (BRAND_COLORS as readonly string[]).includes(rawColor) ? rawColor : '#5B5BF0';

  const rawIcon = typeof obj.icon === 'string' ? obj.icon.trim() : '';
  const icon = (BRAND_ICONS as readonly string[]).includes(rawIcon) ? rawIcon : 'sparkles';

  const url = sanitizeHttpUrl(obj.url);
  const cancel_url = sanitizeHttpUrl(obj.cancel_url);
  const note = typeof obj.note === 'string' ? obj.note.trim().slice(0, 500) : '';

  const confRaw = typeof obj.confidence === 'string' ? obj.confidence.trim().toLowerCase() : '';
  const confidence: Confidence = confRaw === 'high' || confRaw === 'medium' || confRaw === 'low' ? confRaw : 'medium';

  return {
    name,
    amount,
    currency,
    interval,
    interval_count,
    start_date,
    is_trial,
    trial_end_date,
    auto_renew,
    category_id,
    payment_method_id,
    color,
    icon,
    url,
    cancel_url,
    note,
    confidence,
  };
}

function extractOutputText(interaction: unknown): string {
  if (!interaction || typeof interaction !== 'object') return '';
  const record = interaction as {
    output_text?: unknown;
    steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  };
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text.trim();
  }
  if (Array.isArray(record.steps)) {
    const parts: string[] = [];
    for (const step of record.steps) {
      if (step?.type === 'model_output' && Array.isArray(step.content)) {
        for (const item of step.content) {
          if (item?.type === 'text' && typeof item.text === 'string') {
            parts.push(item.text);
          }
        }
      }
    }
    return parts.join('').trim();
  }
  return '';
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function extractUpstreamStatus(cause: unknown): number | null {
  if (!cause || typeof cause !== 'object') return null;
  const obj = cause as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof obj.status === 'number') return obj.status;
  if (typeof obj.statusCode === 'number') return obj.statusCode;
  if (typeof obj.message === 'string' && /\b429\b|rate.?limit|quota/i.test(obj.message)) return 429;
  return null;
}

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
