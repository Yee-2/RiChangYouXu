import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';
import {
  CAPTURE_ACCEPT,
  GEMINI_MODEL_OPTIONS,
  getSavedGeminiModel,
  parseSubscriptionWithGemini,
  prepareReceiptAttachment,
  saveGeminiModel,
  type PreparedAttachment,
} from './gemini';
import { toUserMessage } from './userMessages';
import {
  BRAND_COLORS,
  BRAND_ICONS,
  CURRENCIES,
  categoryDisplayName,
  convertAmount,
  currencySymbol,
  cycleLabel,
  daysBetween,
  formatMoney,
  formatShortDate,
  getRenewalBadge,
  localTodayKey,
  paymentDisplayName,
  previewRenewalSchedule,
  renewalDurationLabel,
  statusLabel,
  t,
  templateDisplayName,
  toMonthlyAmount,
} from './i18n';
import type {
  BillingInterval,
  Category,
  CurrencyCode,
  GeminiModelId,
  Locale,
  ParsedSubscriptionDraft,
  ParseSubscriptionResult,
  PaymentMethod,
  PaymentType,
  Subscription,
  SubscriptionEvent,
  SubscriptionStatus,
  SubscriptionTemplate,
  UserSettings,
} from './types';

export function SheetModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="modal sheet-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button small" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function ServiceTile({
  name,
  color,
  icon,
  size = 'md',
}: {
  name: string;
  color: string;
  icon: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const showLetter = !icon || icon === 'letter';
  return (
    <span className={`service-tile ${size}`} style={{ backgroundColor: color || '#5B5BF0' }}>
      {showLetter ? name.slice(0, 2).toUpperCase() : <Icon name={icon} size={size === 'lg' ? 26 : size === 'sm' ? 16 : 20} />}
    </span>
  );
}

function SubscriptionListRow({
  sub,
  locale,
  subtitle,
  rightMeta,
  muted = false,
  canEdit,
  onSelect,
  onRenew,
}: {
  sub: Subscription;
  locale: Locale;
  subtitle: string;
  rightMeta: ReactNode;
  muted?: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onRenew: () => void;
}) {
  return (
    <div className="sub-row-item">
      <button
        type="button"
        className={`sub-row ${muted ? 'is-muted' : ''}`}
        onClick={onSelect}
      >
        <ServiceTile name={sub.name} color={sub.color} icon={sub.icon} />
        <span className="sub-row-info">
          <b>{sub.name}</b>
          <small>{subtitle}</small>
        </span>
        <span className="sub-row-right">
          <b className="tabular">{formatMoney(sub.amount, sub.currency, locale)}</b>
          {rightMeta}
        </span>
      </button>
      {canEdit && (
        <button
          type="button"
          className="quick-renew-btn"
          onClick={onRenew}
          title={t(locale, 'renewNow')}
          aria-label={`${t(locale, 'renewNow')} ${sub.name}`}
        >
          <Icon name="repeat" size={14} />
          <span>{t(locale, 'renewNow')}</span>
        </button>
      )}
    </div>
  );
}

export function OverviewTab({
  locale,
  baseCurrency,
  subscriptions,
  categories,
  paymentMethods,
  ratesMap,
  canEdit,
  onAdd,
  onSmartAdd,
  onGoSubscriptions,
  onSelectSubscription,
  onRenew,
}: {
  locale: Locale;
  baseCurrency: CurrencyCode;
  subscriptions: Subscription[];
  categories: Category[];
  paymentMethods: PaymentMethod[];
  ratesMap: Map<string, number>;
  canEdit: boolean;
  onAdd: () => void;
  onSmartAdd: () => void;
  onGoSubscriptions: () => void;
  onSelectSubscription: (sub: Subscription) => void;
  onRenew: (sub: Subscription) => void;
}) {
  const todayKey = localTodayKey();
  const monthPrefix = todayKey.slice(0, 7);

  const metrics = useMemo(() => {
    let monthlyTotal = 0;
    let savedMonthly = 0;
    let due7dCount = 0;
    let trialCount = 0;
    let activeCount = 0;

    const categoryTotals = new Map<string, number>();

    for (const sub of subscriptions) {
      const converted = convertAmount(Number(sub.amount), sub.currency, baseCurrency, ratesMap);
      const monthly = toMonthlyAmount(converted, sub.interval, sub.interval_count);

      if (sub.status === 'active' || sub.status === 'trial') {
        monthlyTotal += monthly;
        activeCount += 1;
        if (sub.status === 'trial') trialCount += 1;

        const targetDate = sub.status === 'trial' && sub.trial_end_date ? sub.trial_end_date : sub.next_renewal_date;
        const diff = daysBetween(todayKey, targetDate);
        if (diff >= 0 && diff <= 7) due7dCount += 1;

        const catKey = sub.category_id ?? '__uncategorized__';
        categoryTotals.set(catKey, (categoryTotals.get(catKey) ?? 0) + monthly);
      } else if (sub.status === 'paused' && sub.updated_at.slice(0, 7) === monthPrefix) {
        savedMonthly += monthly;
      } else if (sub.status === 'cancelled' && (sub.cancelled_at ?? sub.updated_at).slice(0, 7) === monthPrefix) {
        savedMonthly += monthly;
      }
    }

    const categoryRows = [...categoryTotals.entries()]
      .map(([catId, amount]) => {
        const cat = categories.find((c) => c.id === catId);
        return {
          id: catId,
          name: categoryDisplayName(cat, locale),
          color: cat?.color ?? '#94A3B8',
          amount,
          share: monthlyTotal > 0 ? (amount / monthlyTotal) * 100 : 0,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    const upcoming = subscriptions
      .filter((sub) => {
        if (sub.status !== 'active' && sub.status !== 'trial') return false;
        const target = sub.status === 'trial' && sub.trial_end_date ? sub.trial_end_date : sub.next_renewal_date;
        const diff = daysBetween(todayKey, target);
        return diff >= 0 && diff <= 30;
      })
      .sort((a, b) => {
        const da = a.status === 'trial' && a.trial_end_date ? a.trial_end_date : a.next_renewal_date;
        const db = b.status === 'trial' && b.trial_end_date ? b.trial_end_date : b.next_renewal_date;
        return da.localeCompare(db) || Number(b.amount) - Number(a.amount);
      })
      .slice(0, 8);

    return {
      monthlyTotal,
      yearlyTotal: monthlyTotal * 12,
      savedMonthly,
      due7dCount,
      trialCount,
      activeCount,
      categoryRows,
      upcoming,
    };
  }, [subscriptions, categories, ratesMap, baseCurrency, locale, todayKey, monthPrefix]);

  return (
    <div className="tab-stack">
      <section className="hero-card">
        <div className="hero-top">
          <div className="hero-main">
            <span className="hero-label">{t(locale, 'monthlySpendLabel')}</span>
            <h1 className="hero-amount tabular">{formatMoney(metrics.monthlyTotal, baseCurrency, locale)}</h1>
            <p className="hero-sub tabular">
              {t(locale, 'yearlyEstimateLabel')} {formatMoney(metrics.yearlyTotal, baseCurrency, locale)} · {metrics.activeCount} {t(locale, 'totalSubscriptionsUnit')}
            </p>
          </div>
          {canEdit && (
            <div className="hero-actions">
              <button type="button" className="hero-ai-btn" onClick={onSmartAdd}>
                <Icon name="sparkles" size={16} />
                <span>{t(locale, 'aiScanBtn')}</span>
              </button>
              <button type="button" className="hero-add-btn" onClick={onAdd}>
                <Icon name="add" size={18} />
                <span>{t(locale, 'addSubscription')}</span>
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="stat-chips-row" aria-label="Summary metrics">
        <div className="stat-chip">
          <span className="stat-icon coral"><Icon name="bell" size={18} /></span>
          <div>
            <small>{t(locale, 'dueIn7d')}</small>
            <b className="tabular">{metrics.due7dCount}</b>
          </div>
        </div>
        <div className="stat-chip">
          <span className="stat-icon amber"><Icon name="sparkles" size={18} /></span>
          <div>
            <small>{t(locale, 'inTrial')}</small>
            <b className="tabular">{metrics.trialCount}</b>
          </div>
        </div>
        <div className="stat-chip">
          <span className="stat-icon mint"><Icon name="trending_up" size={18} /></span>
          <div>
            <small>{t(locale, 'savedThisMonth')}</small>
            <b className="tabular">{formatMoney(metrics.savedMonthly, baseCurrency, locale)}</b>
          </div>
        </div>
      </section>

      <section className="surface-card section-card">
        <div className="section-head">
          <h2>{t(locale, 'upcomingRenewals')}</h2>
          <button type="button" className="text-button" onClick={onGoSubscriptions}>
            {t(locale, 'viewAll')}
            <Icon name="arrow_forward" size={15} />
          </button>
        </div>

        {metrics.upcoming.length === 0 ? (
          <div className="empty-inline">
            <Icon name="calendar" size={24} />
            <div>
              <b>{t(locale, 'noUpcoming')}</b>
              <p>{t(locale, 'noUpcomingHint')}</p>
            </div>
          </div>
        ) : (
          <div className="sub-list">
            {metrics.upcoming.map((sub) => {
              const badge = getRenewalBadge(sub, locale, todayKey);
              const pm = paymentMethods.find((p) => p.id === sub.payment_method_id);
              const subtitle = `${cycleLabel(sub.interval, sub.interval_count, locale)}${pm ? ` · ${paymentDisplayName(pm, locale)}` : ''}`;
              return (
                <SubscriptionListRow
                  key={sub.id}
                  sub={sub}
                  locale={locale}
                  subtitle={subtitle}
                  rightMeta={<span className={`badge-pill ${badge.tone}`}>{badge.text}</span>}
                  canEdit={canEdit}
                  onSelect={() => onSelectSubscription(sub)}
                  onRenew={() => onRenew(sub)}
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="surface-card section-card">
        <div className="section-head">
          <h2>{t(locale, 'categoryBreakdown')}</h2>
          <span className="muted-chip">{baseCurrency}</span>
        </div>

        {metrics.categoryRows.length === 0 ? (
          <div className="empty-inline">
            <Icon name="pie_chart" size={24} />
            <div>
              <b>{t(locale, 'noCategoryData')}</b>
            </div>
          </div>
        ) : (
          <div className="donut-layout">
            <DonutChart
              segments={metrics.categoryRows}
              totalText={formatMoney(metrics.monthlyTotal, baseCurrency, locale)}
              subText={t(locale, 'monthlyAvg')}
            />
            <div className="donut-legend">
              {metrics.categoryRows.map((row) => (
                <div key={row.id} className="legend-row">
                  <span className="legend-left">
                    <i className="dot" style={{ backgroundColor: row.color }} />
                    <span>{row.name}</span>
                  </span>
                  <span className="legend-right tabular">
                    <b>{formatMoney(row.amount, baseCurrency, locale)}</b>
                    <small>{row.share.toFixed(0)}%</small>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function DonutChart({
  segments,
  totalText,
  subText,
}: {
  segments: Array<{ id: string; color: string; share: number }>;
  totalText: string;
  subText: string;
}) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut-svg" aria-hidden="true">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--line)" strokeWidth="18" />
        {segments.map((seg) => {
          const len = (seg.share / 100) * circumference;
          const dashOffset = -offset;
          offset += len;
          return (
            <circle
              key={seg.id}
              cx="70"
              cy="70"
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth="18"
              strokeDasharray={`${Math.max(0, len - 2)} ${circumference}`}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              transform="rotate(-90 70 70)"
            />
          );
        })}
      </svg>
      <div className="donut-center">
        <small>{subText}</small>
        <b className="tabular">{totalText}</b>
      </div>
    </div>
  );
}

export function SubscriptionsTab({
  locale,
  baseCurrency,
  subscriptions,
  categories,
  paymentMethods,
  ratesMap,
  canEdit,
  onAdd,
  onSmartAdd,
  onSelectSubscription,
  onRenew,
}: {
  locale: Locale;
  baseCurrency: CurrencyCode;
  subscriptions: Subscription[];
  categories: Category[];
  paymentMethods: PaymentMethod[];
  ratesMap: Map<string, number>;
  canEdit: boolean;
  onAdd: () => void;
  onSmartAdd: () => void;
  onSelectSubscription: (sub: Subscription) => void;
  onRenew: (sub: Subscription) => void;
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SubscriptionStatus>('all');
  const todayKey = localTodayKey();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return subscriptions.filter((sub) => {
      if (statusFilter !== 'all' && sub.status !== statusFilter) return false;
      if (q && !`${sub.name} ${sub.note}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [subscriptions, search, statusFilter]);

  const summary = useMemo(() => {
    let monthly = 0;
    for (const sub of filtered) {
      if (sub.status === 'active' || sub.status === 'trial') {
        const converted = convertAmount(Number(sub.amount), sub.currency, baseCurrency, ratesMap);
        monthly += toMonthlyAmount(converted, sub.interval, sub.interval_count);
      }
    }
    return { monthly, yearly: monthly * 12 };
  }, [filtered, baseCurrency, ratesMap]);

  const groups = useMemo(() => {
    const map = new Map<string, Subscription[]>();
    for (const sub of filtered) {
      const key = sub.category_id ?? '__uncategorized__';
      const list = map.get(key) ?? [];
      list.push(sub);
      map.set(key, list);
    }
    return [...map.entries()]
      .map(([catId, items]) => {
        const cat = categories.find((c) => c.id === catId);
        return {
          id: catId,
          sort: cat?.sort ?? 999,
          title: categoryDisplayName(cat, locale),
          color: cat?.color ?? '#94A3B8',
          items: items.sort((a, b) => a.next_renewal_date.localeCompare(b.next_renewal_date)),
        };
      })
      .sort((a, b) => a.sort - b.sort);
  }, [filtered, categories, locale]);

  const filterChips: Array<{ id: 'all' | SubscriptionStatus; label: string }> = [
    { id: 'all', label: t(locale, 'filterAll') },
    { id: 'active', label: t(locale, 'filterActive') },
    { id: 'trial', label: t(locale, 'filterTrial') },
    { id: 'paused', label: t(locale, 'filterPaused') },
    { id: 'cancelled', label: t(locale, 'filterCancelled') },
  ];

  return (
    <div className="tab-stack">
      <div className="page-head-row">
        <h1>{t(locale, 'mySubscriptions')}</h1>
        {canEdit && (
          <div className="page-head-actions">
            <button type="button" className="soft-button compact ai-pill-btn" onClick={onSmartAdd}>
              <Icon name="sparkles" size={15} />
              <span>{t(locale, 'aiScanBtn')}</span>
            </button>
            <button type="button" className="round-add-btn" onClick={onAdd} aria-label={t(locale, 'addSubscription')}>
              <Icon name="add" size={22} />
            </button>
          </div>
        )}
      </div>

      <label className="search-field">
        <Icon name="search" size={18} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(locale, 'searchPlaceholder')}
          aria-label={t(locale, 'searchPlaceholder')}
        />
        {search && (
          <button type="button" className="icon-clear" onClick={() => setSearch('')} aria-label="Clear">
            <Icon name="close" size={16} />
          </button>
        )}
      </label>

      <div className="filter-pills-row" role="tablist">
        {filterChips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            role="tab"
            aria-selected={statusFilter === chip.id}
            className={`filter-pill ${statusFilter === chip.id ? 'active' : ''}`}
            onClick={() => setStatusFilter(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="summary-strip tabular">
        <span>
          {t(locale, 'monthlyAvg')} <b>{formatMoney(summary.monthly, baseCurrency, locale)}</b>
        </span>
        <span className="sep">·</span>
        <span>
          {t(locale, 'yearlyTotal')} <b>{formatMoney(summary.yearly, baseCurrency, locale)}</b>
        </span>
      </div>

      {subscriptions.length === 0 ? (
        <div className="surface-card empty-card">
          <span className="empty-icon"><Icon name="repeat" size={28} /></span>
          <h3>{t(locale, 'noSubscriptionsTitle')}</h3>
          <p>{t(locale, 'noSubscriptionsDesc')}</p>
          {canEdit && (
            <button type="button" className="primary-button" onClick={onAdd}>
              <Icon name="add" size={18} />
              {t(locale, 'addSubscription')}
            </button>
          )}
        </div>
      ) : groups.length === 0 ? (
        <div className="surface-card empty-card">
          <span className="empty-icon"><Icon name="search_off" size={26} /></span>
          <h3>{t(locale, 'noMatchTitle')}</h3>
          <p>{t(locale, 'noMatchDesc')}</p>
        </div>
      ) : (
        <div className="grouped-lists">
          {groups.map((group) => (
            <section key={group.id} className="surface-card group-card">
              <header className="group-head">
                <i className="dot" style={{ backgroundColor: group.color }} />
                <span>{group.title}</span>
                <small>{group.items.length}</small>
              </header>
              <div className="sub-list">
                {group.items.map((sub) => {
                  const pm = paymentMethods.find((p) => p.id === sub.payment_method_id);
                  const badge = getRenewalBadge(sub, locale, todayKey);
                  const muted = sub.status === 'paused' || sub.status === 'cancelled';
                  const subtitle = `${cycleLabel(sub.interval, sub.interval_count, locale)}${pm ? ` · ${paymentDisplayName(pm, locale)}` : ''}`;
                  const rightMeta = sub.status === 'trial' || muted ? (
                    <span className={`badge-pill ${badge.tone}`}>{badge.text}</span>
                  ) : (
                    <small className="date-sub">{formatShortDate(sub.next_renewal_date, locale)}</small>
                  );
                  return (
                    <SubscriptionListRow
                      key={sub.id}
                      sub={sub}
                      locale={locale}
                      subtitle={subtitle}
                      rightMeta={rightMeta}
                      muted={muted}
                      canEdit={canEdit}
                      onSelect={() => onSelectSubscription(sub)}
                      onRenew={() => onRenew(sub)}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function occursOnDateInMonth(sub: Subscription, year: number, monthIndex: number): number[] {
  if (sub.status === 'paused' || sub.status === 'cancelled') return [];
  if (sub.status === 'trial') {
    const d = sub.trial_end_date ?? sub.next_renewal_date;
    const [sy, sm, sd] = d.split('-').map(Number);
    return sy === year && sm === monthIndex + 1 ? [sd] : [];
  }

  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const [ay, am, ad] = sub.next_renewal_date.split('-').map(Number);
  if (!ay || !am || !ad) return [];

  const anchorUtc = Date.UTC(ay, am - 1, ad);
  const monthEndUtc = Date.UTC(year, monthIndex, daysInMonth);
  if (anchorUtc > monthEndUtc) return [];

  const count = Math.max(1, sub.interval_count || 1);
  const daysSet = new Set<number>();

  if (sub.interval === 'week' || sub.interval === 'custom') {
    const stepDays = sub.interval === 'week' ? count * 7 : count;
    const monthStartUtc = Date.UTC(year, monthIndex, 1);
    const diffStart = Math.floor((monthStartUtc - anchorUtc) / 86400000);
    let k = diffStart > 0 ? Math.ceil(diffStart / stepDays) : 0;
    while (k < 20000) {
      const dt = new Date(anchorUtc + k * stepDays * 86400000);
      if (dt.getUTCFullYear() > year || (dt.getUTCFullYear() === year && dt.getUTCMonth() > monthIndex)) break;
      if (dt.getUTCFullYear() === year && dt.getUTCMonth() === monthIndex) {
        daysSet.add(dt.getUTCDate());
      }
      k += 1;
    }
    return [...daysSet].sort((a, b) => a - b);
  }

  const stepMonths = sub.interval === 'month' ? count : sub.interval === 'quarter' ? count * 3 : count * 12;
  const monthDiff = (year - ay) * 12 + (monthIndex - (am - 1));
  if (monthDiff >= 0 && monthDiff % stepMonths === 0) {
    daysSet.add(Math.min(ad, daysInMonth));
  }
  return [...daysSet];
}

export function CalendarTab({
  locale,
  baseCurrency,
  subscriptions,
  ratesMap,
  canEdit,
  onSelectSubscription,
  onRenew,
}: {
  locale: Locale;
  baseCurrency: CurrencyCode;
  subscriptions: Subscription[];
  ratesMap: Map<string, number>;
  canEdit: boolean;
  onSelectSubscription: (sub: Subscription) => void;
  onRenew: (sub: Subscription) => void;
}) {
  const todayKey = localTodayKey();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [selectedDay, setSelectedDay] = useState(now.getDate());

  const { dayEvents, monthTotal, cells } = useMemo(() => {
    const map = new Map<number, Subscription[]>();
    let total = 0;

    for (const sub of subscriptions) {
      const days = occursOnDateInMonth(sub, year, month);
      if (!days.length) continue;
      const converted = convertAmount(Number(sub.amount), sub.currency, baseCurrency, ratesMap);
      total += converted * days.length;
      for (const d of days) {
        const list = map.get(d) ?? [];
        list.push(sub);
        map.set(d, list);
      }
    }

    const firstWeekday = new Date(year, month, 1).getDay(); // 0 = Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const gridCells: Array<number | null> = [];
    for (let i = 0; i < firstWeekday; i += 1) gridCells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) gridCells.push(d);

    return { dayEvents: map, monthTotal: total, cells: gridCells };
  }, [subscriptions, year, month, baseCurrency, ratesMap]);

  const shiftMonth = (delta: number) => {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
    setSelectedDay(1);
  };

  const monthLabel = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: 'long',
  }).format(new Date(year, month, 1));

  const weekdays = locale === 'en'
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['日', '一', '二', '三', '四', '五', '六'];

  const selectedDateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(selectedDay).padStart(2, '0')}`;
  const selectedItems = dayEvents.get(selectedDay) ?? [];

  return (
    <div className="tab-stack">
      <div className="page-head-row">
        <h1>{t(locale, 'calendarTitle')}</h1>
        <button
          type="button"
          className="soft-button compact"
          onClick={() => {
            const d = new Date();
            setYear(d.getFullYear());
            setMonth(d.getMonth());
            setSelectedDay(d.getDate());
          }}
        >
          {t(locale, 'calendarToday')}
        </button>
      </div>

      <section className="surface-card calendar-card">
        <div className="calendar-header">
          <div>
            <h2>{monthLabel}</h2>
            <p className="tabular">
              {t(locale, 'calendarMonthTotal')} <b>{formatMoney(monthTotal, baseCurrency, locale)}</b>
            </p>
          </div>
          <div className="calendar-nav">
            <button type="button" className="icon-button small" onClick={() => shiftMonth(-1)} aria-label="Previous month">
              <Icon name="chevron_left" size={18} />
            </button>
            <button type="button" className="icon-button small" onClick={() => shiftMonth(1)} aria-label="Next month">
              <Icon name="chevron_right" size={18} />
            </button>
          </div>
        </div>

        <div className="calendar-weekdays">
          {weekdays.map((wd) => <span key={wd}>{wd}</span>)}
        </div>

        <div className="calendar-grid">
          {cells.map((day, idx) => {
            if (!day) return <span key={`empty-${idx}`} className="cal-cell empty" />;
            const items = dayEvents.get(day) ?? [];
            const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const isToday = key === todayKey;
            const isSelected = day === selectedDay;
            return (
              <button
                type="button"
                key={key}
                className={`cal-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                onClick={() => setSelectedDay(day)}
              >
                <span className="cal-day-num">{day}</span>
                {items.length > 0 && (
                  <span className="cal-dots">
                    {items.slice(0, 3).map((item) => (
                      <i key={item.id} style={{ backgroundColor: item.color }} />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="surface-card section-card">
        <div className="section-head">
          <h2>{formatShortDate(selectedDateKey, locale)}</h2>
          <span className="muted-chip">{selectedItems.length}</span>
        </div>

        {selectedItems.length === 0 ? (
          <div className="empty-inline">
            <Icon name="calendar" size={22} />
            <div><b>{t(locale, 'calendarNoRenewals')}</b></div>
          </div>
        ) : (
          <div className="sub-list">
            {selectedItems.map((sub) => (
              <SubscriptionListRow
                key={sub.id}
                sub={sub}
                locale={locale}
                subtitle={cycleLabel(sub.interval, sub.interval_count, locale)}
                rightMeta={(
                  <span className={`badge-pill ${sub.status === 'trial' ? 'amber' : 'indigo'}`}>
                    {statusLabel(sub.status, locale)}
                  </span>
                )}
                canEdit={canEdit}
                onSelect={() => onSelectSubscription(sub)}
                onRenew={() => onRenew(sub)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function SubscriptionFormModal({
  locale,
  initialSub,
  settings,
  categories,
  paymentMethods,
  templates,
  online,
  initialOpenSmartCapture = false,
  onNotify,
  onClose,
  onSave,
}: {
  locale: Locale;
  initialSub: Subscription | null;
  settings: UserSettings;
  categories: Category[];
  paymentMethods: PaymentMethod[];
  templates: SubscriptionTemplate[];
  online: boolean;
  initialOpenSmartCapture?: boolean;
  onNotify?: (msg: unknown) => void;
  onClose: () => void;
  onSave: (payload: {
    name: string;
    color: string;
    icon: string;
    amount: number;
    currency: CurrencyCode;
    interval: BillingInterval;
    interval_count: number;
    start_date: string;
    status: SubscriptionStatus;
    trial_end_date: string | null;
    auto_renew: boolean;
    category_id: string | null;
    payment_method_id: string | null;
    url: string;
    cancel_url: string;
    note: string;
    reminder_days: number;
  }) => Promise<void>;
}) {
  const todayKey = localTodayKey();
  const [name, setName] = useState(initialSub?.name ?? '');
  const [color, setColor] = useState(initialSub?.color ?? '#5B5BF0');
  const [icon, setIcon] = useState(initialSub?.icon ?? 'sparkles');
  const [amount, setAmount] = useState(initialSub ? String(initialSub.amount) : '');
  const [currency, setCurrency] = useState<CurrencyCode>(initialSub?.currency ?? settings.base_currency);
  const [interval, setInterval] = useState<BillingInterval>(initialSub?.interval ?? 'month');
  const [intervalCount, setIntervalCount] = useState(String(initialSub?.interval_count ?? 1));
  const [startDate, setStartDate] = useState(initialSub?.start_date ?? todayKey);
  const [categoryId, setCategoryId] = useState<string>(initialSub?.category_id ?? (categories[0]?.id ?? ''));
  const [paymentMethodId, setPaymentMethodId] = useState<string>(initialSub?.payment_method_id ?? (paymentMethods[0]?.id ?? ''));
  const [reminderEnabled, setReminderEnabled] = useState((initialSub?.reminder_days ?? settings.default_reminder_days) > 0);
  const [reminderDays, setReminderDays] = useState(String(initialSub?.reminder_days || settings.default_reminder_days || 3));
  const [isTrial, setIsTrial] = useState(initialSub?.status === 'trial');
  const [trialEndDate, setTrialEndDate] = useState(initialSub?.trial_end_date ?? todayKey);
  const [autoRenew, setAutoRenew] = useState(initialSub?.auto_renew ?? true);
  const [url, setUrl] = useState(initialSub?.url ?? '');
  const [cancelUrl, setCancelUrl] = useState(initialSub?.cancel_url ?? '');
  const [note, setNote] = useState(initialSub?.note ?? '');
  const [busy, setBusy] = useState(false);

  const [aiExpanded, setAiExpanded] = useState(!initialSub && initialOpenSmartCapture);
  const [aiModel, setAiModel] = useState<GeminiModelId>(() => getSavedGeminiModel());
  const [aiText, setAiText] = useState('');
  const [aiAttachment, setAiAttachment] = useState<PreparedAttachment | null>(null);
  const [aiParsing, setAiParsing] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiResult, setAiResult] = useState<ParseSubscriptionResult | null>(null);
  const [aiSelectedIdx, setAiSelectedIdx] = useState(0);
  const aiFileInputRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<PreparedAttachment | null>(null);

  useEffect(() => {
    attachmentRef.current = aiAttachment;
  }, [aiAttachment]);

  useEffect(() => {
    return () => {
      if (attachmentRef.current?.previewUrl) {
        URL.revokeObjectURL(attachmentRef.current.previewUrl);
      }
    };
  }, []);

  const clearAttachment = () => {
    setAiAttachment((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  };

  const attachFile = async (file: File) => {
    setAiError('');
    try {
      const prepared = await prepareReceiptAttachment(file);
      setAiAttachment((prev) => {
        if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
        return prepared;
      });
    } catch (cause) {
      setAiError(toUserMessage(cause, locale));
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void attachFile(file);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          void attachFile(file);
          break;
        }
      }
    }
  };

  const applyParsedDraft = (draft: ParsedSubscriptionDraft) => {
    setName(draft.name);
    setAmount(String(draft.amount));
    setCurrency(draft.currency);
    setInterval(draft.interval);
    setIntervalCount(String(draft.interval_count));
    setStartDate(draft.start_date);
    setColor(draft.color);
    setIcon(draft.icon);
    setIsTrial(draft.is_trial);
    setTrialEndDate(draft.trial_end_date ?? todayKey);
    setAutoRenew(draft.auto_renew);
    setUrl(draft.url);
    setCancelUrl(draft.cancel_url);
    setNote(draft.note);
    if (draft.category_id && categories.some((c) => c.id === draft.category_id)) {
      setCategoryId(draft.category_id);
    }
    if (draft.payment_method_id && paymentMethods.some((p) => p.id === draft.payment_method_id)) {
      setPaymentMethodId(draft.payment_method_id);
    }
  };

  const runAiExtract = async () => {
    if (!online || aiParsing) return;
    if (!aiText.trim() && !aiAttachment) {
      setAiError(toUserMessage('input_required', locale));
      return;
    }

    setAiParsing(true);
    setAiError('');
    try {
      const result = await parseSubscriptionWithGemini({
        model: aiModel,
        text: aiText,
        attachment: aiAttachment,
        locale,
        baseCurrency: settings.base_currency,
        categories,
        paymentMethods,
      });
      setAiResult(result);
      setAiSelectedIdx(0);
      if (result.items.length > 0) {
        applyParsedDraft(result.items[0]);
        onNotify?.(t(locale, 'aiFilledHint'));
      }
    } catch (cause) {
      setAiError(toUserMessage(cause, locale));
    } finally {
      setAiParsing(false);
    }
  };

  const applyTemplate = (tpl: SubscriptionTemplate) => {
    setName(templateDisplayName(tpl, locale));
    setColor(tpl.color);
    setIcon(tpl.icon);
    setAmount(String(tpl.default_amount));
    setCurrency(tpl.currency);
    setInterval(tpl.interval);
    setIntervalCount('1');
    setUrl(tpl.url);
    setCancelUrl(tpl.cancel_url);
    const matchedCat = categories.find((c) => c.key === tpl.category_key) ?? categories[0];
    if (matchedCat) setCategoryId(matchedCat.id);
  };

  const resetCustom = () => {
    setName('');
    setColor('#5B5BF0');
    setIcon('sparkles');
    setAmount('');
    setCurrency(settings.base_currency);
    setInterval('month');
    setIntervalCount('1');
    setUrl('');
    setCancelUrl('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const cleanName = name.trim();
    const numericAmount = Number(amount);
    if (!cleanName || !Number.isFinite(numericAmount) || numericAmount < 0) return;

    setBusy(true);
    try {
      const nextStatus: SubscriptionStatus = isTrial
        ? 'trial'
        : initialSub && (initialSub.status === 'paused' || initialSub.status === 'cancelled')
          ? initialSub.status
          : 'active';

      await onSave({
        name: cleanName.slice(0, 80),
        color,
        icon,
        amount: Math.round(numericAmount * 100) / 100,
        currency,
        interval,
        interval_count: Math.max(1, Math.min(365, Number(intervalCount) || 1)),
        start_date: startDate || todayKey,
        status: nextStatus,
        trial_end_date: isTrial ? (trialEndDate || todayKey) : null,
        auto_renew: autoRenew,
        category_id: categoryId || null,
        payment_method_id: paymentMethodId || null,
        url: url.trim(),
        cancel_url: cancelUrl.trim(),
        note: note.trim().slice(0, 500),
        reminder_days: reminderEnabled ? Math.max(1, Math.min(30, Number(reminderDays) || 3)) : 0,
      });
    } finally {
      setBusy(false);
    }
  };

  const cycles: Array<{ id: BillingInterval; label: string }> = [
    { id: 'week', label: t(locale, 'cycleWeek') },
    { id: 'month', label: t(locale, 'cycleMonth') },
    { id: 'quarter', label: t(locale, 'cycleQuarter') },
    { id: 'year', label: t(locale, 'cycleYear') },
    { id: 'custom', label: t(locale, 'cycleCustom') },
  ];

  const activeDraft = aiResult?.items[aiSelectedIdx] ?? null;
  const confidenceBadge = activeDraft
    ? activeDraft.confidence === 'high'
      ? { tone: 'mint', label: t(locale, 'aiConfidenceHigh') }
      : activeDraft.confidence === 'low'
        ? { tone: 'coral', label: t(locale, 'aiConfidenceLow') }
        : { tone: 'amber', label: t(locale, 'aiConfidenceMedium') }
    : null;

  return (
    <SheetModal title={initialSub ? t(locale, 'editSubscription') : t(locale, 'addSubscription')} onClose={onClose}>
      {!initialSub && (
        <section className={`ai-capture-card ${aiExpanded ? 'is-open' : ''}`} aria-label={t(locale, 'aiCaptureTitle')}>
          <button
            type="button"
            className="ai-capture-toggle"
            aria-expanded={aiExpanded}
            onClick={() => setAiExpanded((open) => !open)}
          >
            <span className="ai-capture-icon">
              <Icon name="sparkles" size={17} />
            </span>
            <span className="ai-capture-head-copy">
              <b>{t(locale, 'aiCaptureTitle')}</b>
              <small>{t(locale, 'aiCaptureSubtitle')}</small>
            </span>
            <span className="ai-badge">Gemini</span>
            <Icon name="chevron_right" size={16} className={`ai-chevron ${aiExpanded ? 'open' : ''}`} />
          </button>

          {aiExpanded && (
            <div className="ai-capture-body">
              {!online && (
                <div className="ai-inline-error" role="status">
                  <Icon name="wifi_off" size={15} />
                  <span>{t(locale, 'aiOfflineHint')}</span>
                </div>
              )}

              <label className="ai-model-row">
                <span>{t(locale, 'aiModelLabel')}</span>
                <select
                  className="ai-model-select"
                  value={aiModel}
                  disabled={aiParsing}
                  onChange={(e) => {
                    const next = e.target.value as GeminiModelId;
                    setAiModel(next);
                    saveGeminiModel(next);
                    setAiError('');
                  }}
                >
                  {GEMINI_MODEL_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {locale === 'en' ? opt.en : opt.zh}
                    </option>
                  ))}
                </select>
              </label>

              <textarea
                className="ai-capture-textarea"
                rows={3}
                maxLength={8000}
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                onPaste={handlePaste}
                placeholder={t(locale, 'aiCapturePlaceholder')}
                aria-label={t(locale, 'aiCaptureTitle')}
              />

              {aiAttachment && (
                <div className="ai-attachment-chip">
                  {aiAttachment.previewUrl ? (
                    <img src={aiAttachment.previewUrl} alt={aiAttachment.name} className="ai-attachment-thumb" />
                  ) : (
                    <span className="ai-pdf-badge">
                      <Icon name="article" size={16} />
                    </span>
                  )}
                  <span className="ai-attachment-meta">
                    <b>{aiAttachment.name}</b>
                    <small>{Math.max(1, Math.round(aiAttachment.size / 1024))} KB</small>
                  </span>
                  <button
                    type="button"
                    className="icon-button small"
                    onClick={clearAttachment}
                    aria-label={t(locale, 'aiRemoveAttachment')}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              )}

              <div className="ai-capture-controls">
                <button
                  type="button"
                  className="soft-button compact"
                  disabled={aiParsing}
                  onClick={() => aiFileInputRef.current?.click()}
                >
                  <Icon name="upload_file" size={15} />
                  <span>{t(locale, 'aiAttachFile')}</span>
                </button>
                <input
                  ref={aiFileInputRef}
                  type="file"
                  accept={CAPTURE_ACCEPT}
                  className="visually-hidden-file"
                  onChange={handleFileChange}
                />

                <button
                  type="button"
                  className="primary-button compact ai-extract-btn"
                  disabled={!online || aiParsing || (!aiText.trim() && !aiAttachment)}
                  onClick={() => void runAiExtract()}
                >
                  <Icon name={aiParsing ? 'progress_activity' : 'sparkles'} size={15} className={aiParsing ? 'spin' : ''} />
                  <span>{aiParsing ? t(locale, 'aiExtracting') : t(locale, 'aiExtractAction')}</span>
                </button>
              </div>

              {aiError && (
                <div className="ai-inline-error" role="alert">
                  <Icon name="error" size={15} />
                  <span>{aiError}</span>
                </div>
              )}

              {aiResult && (
                <div className={`ai-result-banner ${aiResult.items.length === 0 ? 'is-empty' : ''}`} role="status">
                  <div className="ai-result-top">
                    <Icon name={aiResult.items.length > 0 ? 'check_circle' : 'info'} size={16} />
                    <span>
                      {aiResult.items.length > 0
                        ? (aiResult.summary || t(locale, 'aiFilledHint'))
                        : (aiResult.summary || t(locale, 'aiNothingFound'))}
                    </span>
                    {confidenceBadge && (
                      <span className={`badge-pill ${confidenceBadge.tone}`}>{confidenceBadge.label}</span>
                    )}
                  </div>

                  {aiResult.items.length > 1 && (
                    <div className="ai-detected-wrap">
                      <small>{t(locale, 'aiMultipleFound')}</small>
                      <div className="ai-detected-pills">
                        {aiResult.items.map((item, idx) => (
                          <button
                            type="button"
                            key={`${item.name}-${idx}`}
                            className={`ai-detected-pill ${idx === aiSelectedIdx ? 'active' : ''}`}
                            onClick={() => {
                              setAiSelectedIdx(idx);
                              applyParsedDraft(item);
                            }}
                          >
                            <span>{item.name}</span>
                            <b className="tabular">{formatMoney(item.amount, item.currency, locale)}</b>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {!initialSub && templates.length > 0 && (
        <div className="template-strip-wrap">
          <small className="field-label">{t(locale, 'quickTemplates')}</small>
          <div className="template-strip">
            <button type="button" className="tpl-chip" onClick={resetCustom}>
              <span className="service-tile sm" style={{ backgroundColor: '#64748B' }}>
                <Icon name="add" size={16} />
              </span>
              <span>{t(locale, 'customTemplate')}</span>
            </button>
            {templates.map((tpl) => (
              <button
                type="button"
                key={tpl.id}
                className={`tpl-chip ${name === templateDisplayName(tpl, locale) ? 'selected' : ''}`}
                onClick={() => applyTemplate(tpl)}
              >
                <ServiceTile name={tpl.name} color={tpl.color} icon={tpl.icon} size="sm" />
                <span>{templateDisplayName(tpl, locale)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <form className="form-stack" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>{t(locale, 'serviceName')}</span>
          <input
            autoFocus={!initialOpenSmartCapture}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder={t(locale, 'serviceNamePlaceholder')}
            required
          />
        </label>

        <div className="two-col">
          <label className="field">
            <span>{t(locale, 'amount')}</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
            />
          </label>
          <label className="field">
            <span>{t(locale, 'currency')}</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value as CurrencyCode)}>
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} {c.symbol}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="field">
          <span>{t(locale, 'billingCycle')}</span>
          <div className="segmented">
            {cycles.map((c) => (
              <button
                type="button"
                key={c.id}
                className={interval === c.id ? 'active' : ''}
                onClick={() => setInterval(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {interval === 'custom' && (
          <label className="field">
            <span>{t(locale, 'customDays')}</span>
            <input
              type="number"
              min="1"
              max="365"
              value={intervalCount}
              onChange={(e) => setIntervalCount(e.target.value)}
              required
            />
          </label>
        )}

        <div className="two-col">
          <label className="field">
            <span>{t(locale, 'firstBillingDate')}</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>{t(locale, 'category')}</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t(locale, 'unassigned')}</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {categoryDisplayName(cat, locale)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span>{t(locale, 'paymentMethod')}</span>
          <select value={paymentMethodId} onChange={(e) => setPaymentMethodId(e.target.value)}>
            <option value="">{t(locale, 'unassigned')}</option>
            {paymentMethods.map((pm) => (
              <option key={pm.id} value={pm.id}>
                {paymentDisplayName(pm, locale)}
              </option>
            ))}
          </select>
        </label>

        <div className="picker-row">
          <div className="field">
            <span>{t(locale, 'brandColor')}</span>
            <div className="swatch-row">
              {BRAND_COLORS.map((hex) => (
                <button
                  type="button"
                  key={hex}
                  className={`swatch ${color === hex ? 'active' : ''}`}
                  style={{ backgroundColor: hex }}
                  onClick={() => setColor(hex)}
                  aria-label={hex}
                />
              ))}
            </div>
          </div>
          <div className="field">
            <span>{t(locale, 'brandIcon')}</span>
            <div className="icon-swatch-row">
              {BRAND_ICONS.map((ic) => (
                <button
                  type="button"
                  key={ic}
                  className={`icon-swatch ${icon === ic ? 'active' : ''}`}
                  onClick={() => setIcon(ic)}
                  aria-label={ic}
                >
                  <Icon name={ic} size={16} />
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="toggle-list">
          <label className="toggle-row">
            <span>{t(locale, 'reminderToggle')}</span>
            <input
              type="checkbox"
              checked={reminderEnabled}
              onChange={(e) => setReminderEnabled(e.target.checked)}
            />
          </label>
          {reminderEnabled && (
            <label className="inline-number-field">
              <span>{t(locale, 'reminderDaysLabel')}</span>
              <div>
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={reminderDays}
                  onChange={(e) => setReminderDays(e.target.value)}
                />
                <span>{t(locale, 'daysBefore')}</span>
              </div>
            </label>
          )}
          <label className="toggle-row">
            <span>{t(locale, 'trialToggle')}</span>
            <input
              type="checkbox"
              checked={isTrial}
              onChange={(e) => setIsTrial(e.target.checked)}
            />
          </label>
          {isTrial && (
            <label className="field">
              <span>{t(locale, 'trialEndDate')}</span>
              <input type="date" value={trialEndDate} onChange={(e) => setTrialEndDate(e.target.value)} required />
            </label>
          )}
          <label className="toggle-row">
            <span>{t(locale, 'autoRenewToggle')}</span>
            <input
              type="checkbox"
              checked={autoRenew}
              onChange={(e) => setAutoRenew(e.target.checked)}
            />
          </label>
        </div>

        <div className="two-col">
          <label className="field">
            <span>{t(locale, 'websiteUrl')}</span>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
          </label>
          <label className="field">
            <span>{t(locale, 'cancelUrl')}</span>
            <input type="url" value={cancelUrl} onChange={(e) => setCancelUrl(e.target.value)} placeholder="https://..." />
          </label>
        </div>

        <label className="field">
          <span>{t(locale, 'note')}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} placeholder={t(locale, 'notePlaceholder')} />
        </label>

        <button type="submit" className="primary-button full-width" disabled={busy}>
          {busy ? t(locale, 'saving') : t(locale, 'saveSubscription')}
        </button>
      </form>
    </SheetModal>
  );
}

export function SubscriptionDetailModal({
  locale,
  sub,
  baseCurrency,
  categories,
  paymentMethods,
  ratesMap,
  events,
  eventsLoading,
  canEdit,
  onClose,
  onEdit,
  onRenew,
  onLogCharge,
  onTogglePause,
  onCancelSub,
  onDelete,
}: {
  locale: Locale;
  sub: Subscription;
  baseCurrency: CurrencyCode;
  categories: Category[];
  paymentMethods: PaymentMethod[];
  ratesMap: Map<string, number>;
  events: SubscriptionEvent[];
  eventsLoading: boolean;
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRenew: () => void;
  onLogCharge: () => Promise<void>;
  onTogglePause: () => Promise<void>;
  onCancelSub: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const badge = getRenewalBadge(sub, locale);
  const cat = categories.find((c) => c.id === sub.category_id);
  const pm = paymentMethods.find((p) => p.id === sub.payment_method_id);
  const converted = convertAmount(Number(sub.amount), sub.currency, baseCurrency, ratesMap);
  const monthlyEquiv = toMonthlyAmount(converted, sub.interval, sub.interval_count);
  const yearlyEquiv = monthlyEquiv * 12;

  const runAction = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <SheetModal title={sub.name} onClose={onClose}>
      <div className="detail-hero">
        <ServiceTile name={sub.name} color={sub.color} icon={sub.icon} size="lg" />
        <div className="detail-hero-copy">
          <div className="detail-price-row">
            <b className="tabular">{formatMoney(sub.amount, sub.currency, locale)}</b>
            <span>/ {cycleLabel(sub.interval, sub.interval_count, locale)}</span>
          </div>
          <div className="detail-badges">
            <span className={`badge-pill ${badge.tone}`}>{badge.text}</span>
            <span className="muted-chip">{categoryDisplayName(cat, locale)}</span>
            {pm && <span className="muted-chip">{paymentDisplayName(pm, locale)}</span>}
          </div>
        </div>
      </div>

      <div className="detail-metrics-grid tabular">
        <div>
          <small>{t(locale, 'nextBilling')}</small>
          <b>{sub.status === 'trial' && sub.trial_end_date ? sub.trial_end_date : sub.next_renewal_date}</b>
        </div>
        <div>
          <small>{t(locale, 'monthlyEquivalent')}</small>
          <b>{formatMoney(monthlyEquiv, baseCurrency, locale)}</b>
        </div>
        <div>
          <small>{t(locale, 'yearlyEquivalent')}</small>
          <b>{formatMoney(yearlyEquiv, baseCurrency, locale)}</b>
        </div>
      </div>

      {(sub.status === 'active' || sub.status === 'trial') && (
        <div className="savings-banner">
          <Icon name="trending_up" size={16} />
          <span>
            {t(locale, 'cancelSaveHint')} <b className="tabular">{formatMoney(yearlyEquiv, baseCurrency, locale)}</b>
          </span>
        </div>
      )}

      {sub.note && <p className="detail-note">{sub.note}</p>}

      {(sub.url || sub.cancel_url) && (
        <div className="detail-links">
          {sub.url && (
            <a className="soft-button compact" href={sub.url} target="_blank" rel="noreferrer">
              <Icon name="open_in_new" size={15} />
              {t(locale, 'openWebsite')}
            </a>
          )}
          {sub.cancel_url && (
            <a className="soft-button compact" href={sub.cancel_url} target="_blank" rel="noreferrer">
              <Icon name="external_link" size={15} />
              {t(locale, 'openCancelUrl')}
            </a>
          )}
        </div>
      )}

      {canEdit && (
        <div className="detail-actions">
          <button type="button" className="primary-button compact" disabled={busy} onClick={onRenew}>
            <Icon name="repeat" size={16} />
            {t(locale, 'renewNow')}
          </button>
          <button type="button" className="soft-button compact" disabled={busy} onClick={() => void runAction(onLogCharge)}>
            <Icon name="check" size={16} />
            {t(locale, 'logChargeAction')}
          </button>
          <button type="button" className="soft-button compact" disabled={busy} onClick={onEdit}>
            <Icon name="edit" size={16} />
            {t(locale, 'editSubscription')}
          </button>
          {sub.status !== 'cancelled' && (
            <button type="button" className="soft-button compact" disabled={busy} onClick={() => void runAction(onTogglePause)}>
              <Icon name={sub.status === 'paused' ? 'play' : 'pause'} size={16} />
              {sub.status === 'paused' ? t(locale, 'resumeAction') : t(locale, 'pauseAction')}
            </button>
          )}
          {sub.status !== 'cancelled' && (
            <button type="button" className="soft-button compact" disabled={busy} onClick={() => void runAction(onCancelSub)}>
              <Icon name="ban" size={16} />
              {t(locale, 'cancelSubAction')}
            </button>
          )}
          <button
            type="button"
            className="danger-button compact"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t(locale, 'deleteSubConfirm'))) void runAction(onDelete);
            }}
          >
            <Icon name="delete" size={16} />
            {t(locale, 'delete')}
          </button>
        </div>
      )}

      <section className="detail-history">
        <h3>{t(locale, 'eventHistory')}</h3>
        {eventsLoading ? (
          <p className="muted">…</p>
        ) : events.length === 0 ? (
          <p className="muted">{t(locale, 'noEvents')}</p>
        ) : (
          <div className="event-list">
            {events.map((ev) => {
              const isInAppRenewal = ev.type === 'charge' && Boolean(ev.meta?.in_app_renewal);
              const cycleCount = Number(ev.meta?.cycles ?? 0);
              const newRenewalMeta = typeof ev.meta?.new_renewal_date === 'string' ? ev.meta.new_renewal_date : '';
              const pmText = locale === 'en'
                ? String(ev.meta?.payment_method_name_en || ev.meta?.payment_method_name || '')
                : String(ev.meta?.payment_method_name || '');
              const noteText = typeof ev.meta?.note === 'string' ? ev.meta.note.trim() : '';
              const metaParts = [ev.occurred_on];
              if (isInAppRenewal && newRenewalMeta) metaParts.push(`→ ${newRenewalMeta}`);
              if (pmText) metaParts.push(pmText);
              if (noteText) metaParts.push(noteText);
              return (
                <div key={ev.id} className="event-row">
                  <div>
                    <b>
                      {isInAppRenewal
                        ? `${t(locale, 'eventInAppRenewal')}${cycleCount > 0 ? ` ×${cycleCount}` : ''}`
                        : ev.type === 'charge'
                          ? t(locale, 'eventCharge')
                          : ev.type === 'price_change'
                            ? t(locale, 'eventPriceChange')
                            : t(locale, 'eventStatusChange')}
                    </b>
                    <small>{metaParts.join(' · ')}</small>
                  </div>
                  <span className="tabular">
                    {ev.type === 'status_change'
                      ? `${statusLabel(String(ev.meta?.from ?? 'active') as SubscriptionStatus, locale)} → ${statusLabel(String(ev.meta?.to ?? 'active') as SubscriptionStatus, locale)}`
                      : formatMoney(ev.amount, ev.currency, locale)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </SheetModal>
  );
}

const RENEWAL_CYCLE_PRESETS = [1, 2, 3, 6, 12] as const;

export function RenewCheckoutModal({
  locale,
  sub,
  baseCurrency,
  paymentMethods,
  ratesMap,
  onClose,
  onConfirmRenew,
}: {
  locale: Locale;
  sub: Subscription;
  baseCurrency: CurrencyCode;
  paymentMethods: PaymentMethod[];
  ratesMap: Map<string, number>;
  onClose: () => void;
  onConfirmRenew: (payload: {
    cycles: number;
    amount: number;
    paymentMethodId: string | null;
    note: string;
  }) => Promise<Subscription | null>;
}) {
  const digits = sub.currency === 'JPY' ? 0 : 2;
  const [cycles, setCycles] = useState<number>(1);
  const [amountInput, setAmountInput] = useState<string>(() => Number(sub.amount).toFixed(digits));
  const [amountOverridden, setAmountOverridden] = useState(false);
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(sub.payment_method_id);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{
    updatedSub: Subscription;
    paidAmount: number;
    cycles: number;
    paymentMethodId: string | null;
  } | null>(null);

  const schedule = useMemo(() => previewRenewalSchedule(sub, cycles), [sub, cycles]);
  const standardTotal = Number((Number(sub.amount) * cycles).toFixed(digits));
  const parsedAmount = Number(amountInput);
  const validAmount = Number.isFinite(parsedAmount) && parsedAmount >= 0;
  const displayAmount = validAmount ? Number(parsedAmount.toFixed(digits)) : 0;
  const convertedTotal = convertAmount(displayAmount, sub.currency, baseCurrency, ratesMap);
  const badge = getRenewalBadge(sub, locale);

  const selectCycles = (nextCycles: number) => {
    setCycles(nextCycles);
    if (!amountOverridden) {
      setAmountInput((Number(sub.amount) * nextCycles).toFixed(digits));
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validAmount || busy) return;
    setBusy(true);
    try {
      const updated = await onConfirmRenew({
        cycles,
        amount: displayAmount,
        paymentMethodId,
        note: note.trim(),
      });
      if (updated) {
        setReceipt({
          updatedSub: updated,
          paidAmount: displayAmount,
          cycles,
          paymentMethodId,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const receiptPm = receipt ? paymentMethods.find((p) => p.id === receipt.paymentMethodId) : null;

  return (
    <SheetModal title={t(locale, 'renewCheckoutTitle')} onClose={onClose}>
      {receipt ? (
        <div className="renewal-receipt">
          <div className="receipt-badge">
            <Icon name="check_circle" size={34} />
          </div>
          <h3>{t(locale, 'renewSuccessTitle')}</h3>
          <p className="muted">{t(locale, 'renewSuccessDesc')}</p>

          <div className="receipt-summary">
            <div className="receipt-row">
              <span>{sub.name}</span>
              <b className="tabular">{formatMoney(receipt.paidAmount, sub.currency, locale)}</b>
            </div>
            <div className="receipt-row">
              <span>{t(locale, 'renewReceiptCycles')}</span>
              <b>
                {receipt.cycles} {t(locale, 'renewCycleUnit')} ({renewalDurationLabel(sub.interval, sub.interval_count, receipt.cycles, locale)})
              </b>
            </div>
            <div className="receipt-row">
              <span>{t(locale, 'renewSelectPayment')}</span>
              <b>{receiptPm ? paymentDisplayName(receiptPm, locale) : t(locale, 'unassigned')}</b>
            </div>
            <div className="receipt-row highlight">
              <span>{t(locale, 'renewNewDue')}</span>
              <b className="tabular">{receipt.updatedSub.next_renewal_date}</b>
            </div>
          </div>

          <button type="button" className="primary-button full-width" onClick={onClose}>
            {t(locale, 'renewReceiptDone')}
          </button>
        </div>
      ) : (
        <form className="form-stack" onSubmit={(e) => void handleSubmit(e)}>
          <div className="checkout-hero">
            <ServiceTile name={sub.name} color={sub.color} icon={sub.icon} size="lg" />
            <div className="checkout-hero-copy">
              <b>{sub.name}</b>
              <div className="checkout-hero-meta">
                <span className="tabular">{formatMoney(sub.amount, sub.currency, locale)} / {cycleLabel(sub.interval, sub.interval_count, locale)}</span>
                <span className={`badge-pill ${badge.tone}`}>{badge.text}</span>
              </div>
            </div>
          </div>

          <div>
            <span className="field-label">{t(locale, 'renewCyclesLabel')}</span>
            <div className="cycle-grid">
              {RENEWAL_CYCLE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`cycle-card ${cycles === preset ? 'active' : ''}`}
                  onClick={() => selectCycles(preset)}
                >
                  <b>×{preset}</b>
                  <small>{renewalDurationLabel(sub.interval, sub.interval_count, preset, locale)}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="rollover-preview-card">
            <div className="rollover-head">
              <span>{t(locale, 'renewSchedulePreview')}</span>
              <span className={`badge-pill ${schedule.isExtend ? 'mint' : 'indigo'}`}>
                {schedule.isExtend ? t(locale, 'renewFromExisting') : t(locale, 'renewFromToday')}
              </span>
            </div>
            <div className="rollover-dates tabular">
              <div>
                <small>{t(locale, 'renewCurrentDue')}</small>
                <b>{schedule.currentDue}</b>
              </div>
              <Icon name="arrow_forward" size={16} />
              <div>
                <small>{t(locale, 'renewNewDue')}</small>
                <b className="rollover-target">{schedule.nextRenewalDate}</b>
              </div>
            </div>
          </div>

          <div>
            <span className="field-label">{t(locale, 'renewSelectPayment')}</span>
            <div className="pm-select-grid">
              {paymentMethods.map((pm) => (
                <button
                  key={pm.id}
                  type="button"
                  className={`pm-select-chip ${paymentMethodId === pm.id ? 'active' : ''}`}
                  onClick={() => setPaymentMethodId(pm.id)}
                >
                  <Icon name={pm.type === 'wallet' ? 'wallet' : 'credit_card'} size={15} />
                  <span>{paymentDisplayName(pm, locale)}</span>
                </button>
              ))}
              {(paymentMethods.length === 0 || sub.payment_method_id === null) && (
                <button
                  type="button"
                  className={`pm-select-chip ${paymentMethodId === null ? 'active' : ''}`}
                  onClick={() => setPaymentMethodId(null)}
                >
                  <span>{t(locale, 'unassigned')}</span>
                </button>
              )}
            </div>
          </div>

          <div className="field">
            <div className="field-head-split">
              <span>{t(locale, 'renewAmountLabel')} ({currencySymbol(sub.currency).trim()} {sub.currency})</span>
              {amountOverridden && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setAmountOverridden(false);
                    setAmountInput(standardTotal.toFixed(digits));
                  }}
                >
                  {t(locale, 'renewResetStandard')}
                </button>
              )}
            </div>
            <input
              type="number"
              step={sub.currency === 'JPY' ? '1' : '0.01'}
              min="0"
              value={amountInput}
              onChange={(e) => {
                setAmountOverridden(true);
                setAmountInput(e.target.value);
              }}
              required
            />
            {sub.currency !== baseCurrency && validAmount && (
              <small className="muted tabular">≈ {formatMoney(convertedTotal, baseCurrency, locale)}</small>
            )}
          </div>

          <label className="field">
            <span>{t(locale, 'renewNoteLabel')}</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
              placeholder={t(locale, 'renewNotePlaceholder')}
            />
          </label>

          <button type="submit" className="primary-button full-width" disabled={busy || !validAmount}>
            <Icon name="check" size={17} />
            {busy
              ? t(locale, 'renewProcessing')
              : `${t(locale, 'renewConfirmPay')} · ${formatMoney(displayAmount, sub.currency, locale)}`}
          </button>

          {sub.url && (
            <a className="checkout-official-link" href={sub.url} target="_blank" rel="noreferrer">
              {t(locale, 'renewOfficialPortal')}
              <Icon name="open_in_new" size={14} />
            </a>
          )}
        </form>
      )}
    </SheetModal>
  );
}

export function CategoriesModal({
  locale,
  categories,
  onClose,
  onAdd,
  onDelete,
}: {
  locale: Locale;
  categories: Category[];
  onClose: () => void;
  onAdd: (payload: { name: string; name_en: string; color: string; icon: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const isEn = locale === 'en';
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [color, setColor] = useState('#5B5BF0');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onAdd({ name: name.trim(), name_en: nameEn.trim() || name.trim(), color, icon: 'sparkles' });
      setName('');
      setNameEn('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetModal title={t(locale, 'manageCategories')} onClose={onClose}>
      <div className="manage-list">
        {categories.map((cat) => (
          <div key={cat.id} className="manage-row">
            <span className="manage-left">
              <i className="dot" style={{ backgroundColor: cat.color }} />
              <b>{categoryDisplayName(cat, locale)}</b>
            </span>
            <button type="button" className="icon-button small" onClick={() => void onDelete(cat.id)} aria-label="Delete">
              <Icon name="delete" size={16} />
            </button>
          </div>
        ))}
      </div>
      <form className="form-stack" onSubmit={(e) => void submit(e)}>
        <div className="two-col">
          <label className="field">
            <span>{isEn ? 'Name (ZH)' : '分类名称'}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
          </label>
          <label className="field">
            <span>{isEn ? 'Name (EN)' : '英文名称'}</span>
            <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={40} />
          </label>
        </div>
        <div className="swatch-row">
          {BRAND_COLORS.map((hex) => (
            <button
              type="button"
              key={hex}
              className={`swatch ${color === hex ? 'active' : ''}`}
              style={{ backgroundColor: hex }}
              onClick={() => setColor(hex)}
              aria-label={hex}
            />
          ))}
        </div>
        <button type="submit" className="primary-button" disabled={busy}>
          <Icon name="add" size={17} />
          {isEn ? 'Add Category' : '添加分类'}
        </button>
      </form>
    </SheetModal>
  );
}

export function PaymentMethodsModal({
  locale,
  paymentMethods,
  onClose,
  onAdd,
  onDelete,
}: {
  locale: Locale;
  paymentMethods: PaymentMethod[];
  onClose: () => void;
  onAdd: (payload: { name: string; name_en: string; type: PaymentType; last4: string | null }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const isEn = locale === 'en';
  const [name, setName] = useState('');
  const [type, setType] = useState<PaymentType>('card');
  const [last4, setLast4] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const cleanLast4 = last4.replace(/\D/g, '').slice(0, 4);
      await onAdd({
        name: name.trim(),
        name_en: name.trim(),
        type,
        last4: cleanLast4.length === 4 ? cleanLast4 : null,
      });
      setName('');
      setLast4('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetModal title={t(locale, 'managePayments')} onClose={onClose}>
      <div className="manage-list">
        {paymentMethods.map((pm) => (
          <div key={pm.id} className="manage-row">
            <span className="manage-left">
              <Icon name="credit_card" size={18} />
              <b>{paymentDisplayName(pm, locale)}</b>
            </span>
            <button type="button" className="icon-button small" onClick={() => void onDelete(pm.id)} aria-label="Delete">
              <Icon name="delete" size={16} />
            </button>
          </div>
        ))}
      </div>
      <form className="form-stack" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>{isEn ? 'Method Name' : '名称'}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={isEn ? 'e.g. CMB Visa' : '例如：招行 Visa'} required />
        </label>
        <div className="two-col">
          <label className="field">
            <span>{isEn ? 'Type' : '类型'}</span>
            <select value={type} onChange={(e) => setType(e.target.value as PaymentType)}>
              <option value="card">{isEn ? 'Card' : '银行卡'}</option>
              <option value="alipay">{isEn ? 'Alipay' : '支付宝'}</option>
              <option value="wechat">{isEn ? 'WeChat Pay' : '微信支付'}</option>
              <option value="apple_pay">Apple Pay</option>
              <option value="paypal">PayPal</option>
              <option value="other">{isEn ? 'Other' : '其他'}</option>
            </select>
          </label>
          <label className="field">
            <span>{isEn ? 'Last 4 digits (optional)' : '卡号后四位（可选）'}</span>
            <input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} maxLength={4} placeholder="8888" />
          </label>
        </div>
        <button type="submit" className="primary-button" disabled={busy}>
          <Icon name="add" size={17} />
          {isEn ? 'Add Payment Method' : '添加支付方式'}
        </button>
      </form>
    </SheetModal>
  );
}
