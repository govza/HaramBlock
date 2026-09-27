import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useMemo, useState } from 'react';

import { LoadingSpinner } from '@/entrypoints/options/components/LoadingSpinner';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';
import { getLogger } from '@/utils/telemetry';

import type { HostScopedCacheRepository } from '@/utils/db/hostScopedCacheRepository';
import type { ForcedVisibility, IElementPrediction, IImagePrediction, IVideoPredictionRecord } from '@/utils/types';

const log = getLogger('CacheBrowser');

const PAGE_SIZE = 25;

const DANGER_BUTTON_CLASS =
  'text-danger-light hover:text-danger text-sm px-2 py-1 rounded transition-colors cursor-pointer shrink-0';
const SECONDARY_BUTTON_CLASS =
  'bg-surface text-text-primary px-4 py-2 rounded-lg text-base cursor-pointer hover:bg-surface-light disabled:opacity-50 disabled:cursor-not-allowed';

type CacheKind = 'images' | 'videos';

type CacheRecord = IImagePrediction | IVideoPredictionRecord;

interface ICacheRow {
  key: string;
  timestamp: number;
  forcedVisibility: ForcedVisibility;
  modelId?: string;
  predictions: IElementPrediction[];
  detail: string;
}

interface ICachePage {
  rows: ICacheRow[];
  total: number;
  page: number;
}

interface IMediaProps {
  src: string;
  className: string;
}

interface ICacheSource {
  repository: Pick<
    HostScopedCacheRepository<CacheRecord>,
    'count' | 'delete' | 'deleteByHostname' | 'clear' | 'listHostSummaries'
  >;
  loadPage: (hostname: string, page: number) => Promise<ICachePage>;
  Media: (props: IMediaProps) => ReactNode;
}

const forcedVisibilityLabelKeys = {
  visible: 'OptionsPage.Cache.forcedVisible',
  blocked: 'OptionsPage.Cache.forcedBlocked',
} as const;

const imageToRow = (record: IImagePrediction): ICacheRow => ({
  key: record.src,
  timestamp: record.timestamp,
  forcedVisibility: record.forcedVisibility,
  modelId: record.modelId,
  predictions: record.predictions,
  detail: t('OptionsPage.Cache.dimensions', [String(record.width), String(record.height)]),
});

const videoToRow = (record: IVideoPredictionRecord): ICacheRow => ({
  key: record.videoUrl,
  timestamp: record.timestamp,
  forcedVisibility: record.forcedVisibility,
  modelId: record.modelId,
  predictions: record.samples.flatMap(sample => sample.predictions),
  detail: t('OptionsPage.Cache.samples', [String(record.samples.length)]),
});

const ImageMedia = ({ src, className }: IMediaProps) => <img src={src} loading='lazy' alt='' className={className} />;

const VideoMedia = ({ src, className }: IMediaProps) => (
  <video src={src} preload='metadata' muted className={className} />
);

const createCacheSource = <T extends CacheRecord>(
  repository: HostScopedCacheRepository<T>,
  toRow: (record: T) => ICacheRow,
  Media: ICacheSource['Media'],
): ICacheSource => ({
  repository,
  loadPage: async (hostname, page) => {
    const { records, total, page: clampedPage } = await repository.findNewestPageByHostname(hostname, page, PAGE_SIZE);
    return { rows: records.map(toRow), total, page: clampedPage };
  },
  Media,
});

const useCacheSources = (): Record<CacheKind, ICacheSource> => {
  const { imagePredictionRepository, videoPredictionRepository } = useHostDataContext();
  return useMemo(
    () => ({
      images: createCacheSource(imagePredictionRepository, imageToRow, ImageMedia),
      videos: createCacheSource(videoPredictionRepository, videoToRow, VideoMedia),
    }),
    [imagePredictionRepository, videoPredictionRepository],
  );
};

const runLogged = (action: () => Promise<unknown>, event: string) => {
  action().catch((error: unknown) => log.error(event, { error }));
};

const findTopPrediction = (predictions: IElementPrediction[]) =>
  predictions.reduce<IElementPrediction | undefined>(
    (top, prediction) => (!top || prediction.probability > top.probability ? prediction : top),
    undefined,
  );

const formatTopPrediction = (predictions: IElementPrediction[]) => {
  const topPrediction = findTopPrediction(predictions);
  if (!topPrediction) return t('OptionsPage.Cache.noDetections');
  return t('OptionsPage.Cache.detection', [
    topPrediction.className,
    String(Math.round(topPrediction.probability * 100)),
  ]);
};

const Thumbnail = ({ source, src }: { source: ICacheSource; src: string }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const { Media } = source;

  return (
    <button
      type='button'
      onClick={() => setIsLoaded(prev => !prev)}
      title={t('OptionsPage.Cache.togglePreview')}
      className='w-20 h-20 shrink-0 overflow-hidden rounded bg-secondary cursor-pointer text-text-muted text-xs'
    >
      {isLoaded ? <Media src={src} className='w-full h-full object-cover' /> : t('OptionsPage.Cache.loadPreview')}
    </button>
  );
};

const ConfirmButton = ({ label, onConfirm }: { label: string; onConfirm: () => void }) => {
  const [isConfirming, setIsConfirming] = useState(false);

  return (
    <button
      type='button'
      onClick={() => {
        if (isConfirming) {
          onConfirm();
        }
        setIsConfirming(prev => !prev);
      }}
      onMouseLeave={() => setIsConfirming(false)}
      onBlur={() => setIsConfirming(false)}
      className={DANGER_BUTTON_CLASS}
    >
      {isConfirming ? t('OptionsPage.Cache.clearConfirm') : label}
    </button>
  );
};

const LoadableList = <T,>({ items, renderItem }: { items: T[] | undefined; renderItem: (item: T) => ReactNode }) => {
  if (!items) return <LoadingSpinner />;
  if (items.length === 0) return <p className='text-text-muted text-base py-4'>{t('Common.noData')}</p>;
  return <div className='space-y-2'>{items.map(renderItem)}</div>;
};

const CacheRow = ({ source, row }: { source: ICacheSource; row: ICacheRow }) => (
  <div className='flex items-center gap-3 bg-surface p-3 rounded'>
    <Thumbnail source={source} src={row.key} />
    <div className='flex-1 min-w-0 space-y-1'>
      <a
        href={row.key}
        target='_blank'
        rel='noreferrer'
        className='block truncate text-text-secondary text-sm hover:underline'
      >
        {row.key}
      </a>
      <div className='flex flex-wrap gap-x-4 gap-y-1 text-text-muted text-xs'>
        <span>{new Date(row.timestamp).toLocaleString()}</span>
        <span>{row.detail}</span>
        <span>{formatTopPrediction(row.predictions)}</span>
        {row.forcedVisibility !== 'auto' && (
          <span className='text-accent'>{t(forcedVisibilityLabelKeys[row.forcedVisibility])}</span>
        )}
        {row.modelId && <span>{row.modelId}</span>}
      </div>
    </div>
    <button
      type='button'
      onClick={() => runLogged(() => source.repository.delete(row.key), 'ui.cache.delete_failed')}
      className={DANGER_BUTTON_CLASS}
    >
      {t('Common.remove')}
    </button>
  </div>
);

const CacheHostList = ({ source, onSelect }: { source: ICacheSource; onSelect: (hostname: string) => void }) => {
  const [hostFilter, setHostFilter] = useState('');
  const summaries = useLiveQuery(() => source.repository.listHostSummaries(), [source]);

  const normalizedFilter = hostFilter.trim().toLowerCase();
  const visibleSummaries = summaries?.filter(summary => summary.hostname.toLowerCase().includes(normalizedFilter));

  return (
    <>
      <div className='p-4 border-b border-border-secondary flex items-center space-x-2'>
        <input
          type='text'
          value={hostFilter}
          onChange={e => setHostFilter(e.target.value)}
          className='flex-1 bg-surface border border-border-secondary text-text-secondary text-base rounded-lg p-2'
          placeholder={t('OptionsPage.Cache.filterPlaceholder')}
        />
        <ConfirmButton
          label={t('OptionsPage.Cache.clearAll')}
          onConfirm={() => runLogged(() => source.repository.clear(), 'ui.cache.clear_failed')}
        />
      </div>

      <div className='p-4'>
        <LoadableList
          items={visibleSummaries}
          renderItem={summary => (
            <div key={summary.hostname} className='flex items-center gap-3 bg-surface rounded'>
              <button
                type='button'
                onClick={() => onSelect(summary.hostname)}
                className='flex-1 min-w-0 flex items-center justify-between gap-3 p-3 rounded text-start cursor-pointer hover:bg-surface-light transition-colors'
              >
                <span className='truncate text-text-secondary text-base'>{summary.hostname}</span>
                <span className='text-text-muted text-sm'>
                  {t('OptionsPage.Cache.itemCount', [String(summary.count)])}
                </span>
              </button>
              <ConfirmButton
                label={t('Common.remove')}
                onConfirm={() =>
                  runLogged(() => source.repository.deleteByHostname(summary.hostname), 'ui.cache.clear_host_failed')
                }
              />
            </div>
          )}
        />
      </div>
    </>
  );
};

const Pager = ({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}) => (
  <div className='p-4 border-t border-border-secondary flex items-center justify-between'>
    <button type='button' onClick={() => onChange(page - 1)} disabled={page === 0} className={SECONDARY_BUTTON_CLASS}>
      {t('OptionsPage.Cache.previous')}
    </button>
    <span className='text-text-muted text-sm'>
      {t('OptionsPage.Cache.pageOf', [String(page + 1), String(pageCount)])}
    </span>
    <button
      type='button'
      onClick={() => onChange(page + 1)}
      disabled={page >= pageCount - 1}
      className={SECONDARY_BUTTON_CLASS}
    >
      {t('OptionsPage.Cache.next')}
    </button>
  </div>
);

const CacheHostItems = ({
  source,
  hostname,
  onBack,
}: {
  source: ICacheSource;
  hostname: string;
  onBack: () => void;
}) => {
  const [requestedPage, setRequestedPage] = useState(0);
  const cachePage = useLiveQuery(() => source.loadPage(hostname, requestedPage), [source, hostname, requestedPage]);

  const pageCount = Math.max(1, Math.ceil((cachePage?.total ?? 0) / PAGE_SIZE));

  return (
    <>
      <div className='p-4 border-b border-border-secondary flex items-center gap-3'>
        <button type='button' onClick={onBack} className={SECONDARY_BUTTON_CLASS}>
          {t('OptionsPage.Cache.backToHosts')}
        </button>
        <span className='flex-1 truncate text-text-primary text-base font-medium'>
          {t('OptionsPage.Cache.labelWithCount', [hostname, String(cachePage?.total ?? 0)])}
        </span>
        <ConfirmButton
          label={t('OptionsPage.Cache.clearAll')}
          onConfirm={() => runLogged(() => source.repository.deleteByHostname(hostname), 'ui.cache.clear_host_failed')}
        />
      </div>

      <div className='p-4'>
        <LoadableList
          items={cachePage?.rows}
          renderItem={row => <CacheRow key={row.key} source={source} row={row} />}
        />
      </div>

      {cachePage && pageCount > 1 && <Pager page={cachePage.page} pageCount={pageCount} onChange={setRequestedPage} />}
    </>
  );
};

const CacheKindTab = ({
  kind,
  source,
  isActive,
  onSelect,
}: {
  kind: CacheKind;
  source: ICacheSource;
  isActive: boolean;
  onSelect: () => void;
}) => {
  const count = useLiveQuery(() => source.repository.count(), [source]);

  return (
    <button
      type='button'
      onClick={onSelect}
      className={`px-6 py-3 text-base font-medium transition-all duration-300 cursor-pointer ${
        isActive
          ? 'bg-surface text-text-primary border-b-2 border-accent shadow-sm'
          : 'bg-secondary text-text-muted hover:text-text-primary hover:bg-surface'
      }`}
    >
      {t('OptionsPage.Cache.labelWithCount', [t(`OptionsPage.Cache.${kind}`), String(count ?? 0)])}
    </button>
  );
};

const cacheKinds: CacheKind[] = ['images', 'videos'];

export const CacheBrowser = () => {
  const sources = useCacheSources();
  const [kind, setKind] = useState<CacheKind>('images');
  const [selectedHost, setSelectedHost] = useState<string | undefined>();
  const source = sources[kind];

  return (
    <div className='space-y-6'>
      <div className='border-b border-border-primary pb-4'>
        <h2 className='text-2xl font-bold text-text-primary mb-2'>{t('OptionsPage.Cache.title')}</h2>
        <p className='text-text-muted text-base'>{t('OptionsPage.Cache.description')}</p>
      </div>

      <div className='inline-flex border-b border-border-secondary overflow-hidden'>
        {cacheKinds.map(tabKind => (
          <CacheKindTab
            key={tabKind}
            kind={tabKind}
            source={sources[tabKind]}
            isActive={kind === tabKind}
            onSelect={() => {
              setKind(tabKind);
              setSelectedHost(undefined);
            }}
          />
        ))}
      </div>

      <div className='bg-secondary rounded-lg overflow-hidden'>
        {selectedHost ? (
          <CacheHostItems
            key={`${kind}:${selectedHost}`}
            source={source}
            hostname={selectedHost}
            onBack={() => setSelectedHost(undefined)}
          />
        ) : (
          <CacheHostList source={source} onSelect={setSelectedHost} />
        )}
      </div>
    </div>
  );
};
